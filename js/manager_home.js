/**
 * アレグリア シフト管理ツール - 店長トップページ（manager-home.html 専用・v2）
 *
 * リッチメニュー「店長メニュー🔑」から起動する店長専用の入口。
 * 認証は submit-v2 / admin-v2 と同じ line-auth → Supabaseセッションを流用し、
 * store_members.role で描画を出し分ける（データ保護の本体はRLS＝is_manager_of()）。
 *
 * ロード順: config_v2.js → api_v2.js → manager_home.js
 * calendar.js には依存しない。個別スタッフの明細は confirm-item 形式で自前描画する。
 */

// ============================================================
// 状態（このページ専用。submit-v2 / admin-v2 とは独立）
// ============================================================

const MgrState = {
  userId     : null,
  displayName: null,
  managed    : [],    // 店長権限(admin/manager)を持つ所属 [{store_id, store_name, role, ...}]
  storeId    : null,  // 表示中の店舗
  period     : null,  // 表示中店舗の今期（open）VM または null
  staff      : []     // 対象スタッフ [{id, name, sortOrder, submitted}]
};

// ============================================================
// 汎用ユーティリティ
// ============================================================

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  const target = document.getElementById('screen-' + screenId);
  if (target) {
    target.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    console.error('[showScreen] 存在しないスクリーン:', screenId);
  }
}

function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), duration);
}

function showError(message) {
  const el = document.getElementById('error-message');
  if (el) el.textContent = message;
  showScreen('error');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** "YYYY-MM-DD" → "M月D日（曜）" */
function formatDateLabel(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  if (isNaN(d.getTime())) return String(dateStr);
  const youbi = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return (d.getMonth() + 1) + '月' + d.getDate() + '日（' + youbi + '）';
}

// ============================================================
// 店長トップ本体
// ============================================================

const ManagerHome = {

  _selectedStore() {
    return MgrState.managed.find(m => m.store_id === MgrState.storeId) || null;
  },

  /** ヘッダー（店名・ログイン中ユーザー・店舗切替タブ）を描画 */
  _renderHeader() {
    const store = this._selectedStore();
    const storeEl = document.getElementById('mgr-store-name');
    const userEl  = document.getElementById('mgr-user-name');
    if (storeEl) storeEl.textContent = store ? store.store_name : '';
    if (userEl)  userEl.textContent  = MgrState.displayName || '';

    const tabs = document.getElementById('mgr-store-tabs');
    if (!tabs) return;
    // 掛け持ち店長のときだけ切替タブを出す
    if (MgrState.managed.length < 2) {
      tabs.style.display = 'none';
      return;
    }
    tabs.style.display = '';
    tabs.innerHTML = MgrState.managed.map(m => `
      <button class="store-tab${m.store_id === MgrState.storeId ? ' on' : ''}"
        onclick="ManagerHome.switchStore('${m.store_id}')">${escapeHtml(m.store_name)}</button>
    `).join('');
  },

  switchStore(storeId) {
    if (!MgrState.managed.some(m => m.store_id === storeId)) return;
    MgrState.storeId = storeId;
    this.showHome();
  },

  /**
   * 選択中の店の「スプレッドシートを開く」ボタンを描画する。
   * spreadsheet_id と sheet_gid の両方がそろっている店だけボタンを出し、
   * 欠ける店ではDOMごと出さない（disabledにはしない）。
   * showHome() から毎回呼ぶので、店舗切替でリンク先も更新される。
   */
  _renderSheetButton() {
    const holder = document.getElementById('mgr-sheet-card');
    if (!holder) return;

    const store = this._selectedStore();
    const sid   = store ? store.spreadsheet_id : null;
    const gid   = store ? store.sheet_gid      : null;

    // null / undefined / 空文字は「未設定」。gid=0 は正当な値なので != null で許容。
    const hasSid = sid != null && String(sid).trim() !== '';
    const hasGid = gid != null && String(gid).trim() !== '';
    if (!hasSid || !hasGid) {
      holder.innerHTML = '';
      return;
    }

    const url = 'https://docs.google.com/spreadsheets/d/'
      + encodeURIComponent(sid) + '/edit#gid=' + encodeURIComponent(gid);
    holder.innerHTML = `
      <div class="mgr-card">
        <p class="mgr-card-title">シフト表</p>
        <a class="btn-sheet" href="${url}" target="_blank" rel="noopener">
          📊 スプレッドシートを開く
        </a>
      </div>`;
  },

  /** ホーム画面（提出状況カード＋メンバー管理カード）を描画 */
  async showHome() {
    showScreen('home');
    this._renderHeader();
    this._renderSheetButton();

    const card = document.getElementById('mgr-submission-card');
    card.innerHTML = '<p class="loading-text">提出状況を読み込み中…</p>';

    try {
      const storeId = MgrState.storeId;
      const period  = await SupaAPI.getManagerOpenPeriod(storeId);
      const staff   = await SupaAPI.getEligibleStaff(storeId);
      const submittedIds = period
        ? await SupaAPI.getSubmittedUserIds(period.id)
        : new Set();

      // 詳細一覧でも使うので状態に持たせる（再取得せず遷移できる）
      MgrState.period = period;
      MgrState.staff  = staff.map(s => ({ ...s, submitted: submittedIds.has(s.id) }));

      const eligible  = MgrState.staff.length;
      const submitted = MgrState.staff.filter(s => s.submitted).length;

      if (!period) {
        card.innerHTML = `
          <p class="mgr-card-title">提出状況</p>
          <p class="info-text">現在、受付中の期間はありません。</p>
        `;
        return;
      }

      card.innerHTML = `
        <p class="mgr-card-title">提出状況</p>
        <p class="mgr-period-title">${escapeHtml(period.title)}</p>
        <p class="mgr-count">提出 <strong>${submitted}</strong> / ${eligible}名</p>
        <button class="btn-primary" onclick="ManagerHome.openDetail()">提出状況の詳細を見る</button>
      `;
    } catch (err) {
      console.error('[ManagerHome.showHome]', err);
      card.innerHTML = `
        <p class="mgr-card-title">提出状況</p>
        <p class="error-text">${escapeHtml(err.message)}</p>
        <button class="btn-secondary" onclick="ManagerHome.showHome()">再読み込み</button>
      `;
    }
  },

  /**
   * 「👥 メンバー管理」→ 既存 admin-v2.html へ。
   * from=manager を渡すと、admin-v2 側の戻るボタンが「店長トップへ戻る」になり
   * ここ（manager-home）へ戻る。?v= はキャッシュバスター。
   */
  openMembers() {
    location.href = 'admin-v2.html?v=20260702-v2&from=manager';
  },

  // --------------------------------------------------------
  // 提出状況の詳細一覧
  // --------------------------------------------------------

  openDetail() {
    showScreen('detail');
    const period = MgrState.period;
    const labelEl = document.getElementById('mgr-detail-period');
    if (labelEl) labelEl.textContent = period ? period.title : '';

    const list = document.getElementById('mgr-detail-list');
    if (!MgrState.staff.length) {
      list.innerHTML = '<p class="info-text">対象スタッフがいません。</p>';
      return;
    }

    const submitted = MgrState.staff.filter(s => s.submitted).length;
    const summaryEl = document.getElementById('mgr-detail-summary');
    if (summaryEl) {
      summaryEl.textContent = `提出済み ${submitted}名 / ${MgrState.staff.length}名`;
    }

    list.innerHTML = MgrState.staff.map((s, index) => {
      const stateClass = s.submitted ? 'status-submitted' : 'status-missing';
      const stateLabel = s.submitted ? '提出済み' : '未提出';
      return `
        <button class="manage-member-btn" onclick="ManagerHome.openMember(${index})">
          <span>${escapeHtml(s.name)}</span>
          <span class="${stateClass}">${stateLabel}</span>
        </button>`;
    }).join('');
  },

  /**
   * 個別スタッフをタップ → その submission の明細（約15行）だけを取得して表示。
   * ここで初めて submission_items を引く（データ取得3原則）。
   */
  async openMember(index) {
    const member = MgrState.staff[index];
    const period = MgrState.period;
    if (!member || !period) return;
    if (!member.submitted) {
      showToast('このスタッフはまだ提出していません');
      return;
    }

    showScreen('member-detail');
    document.getElementById('mgr-member-name').textContent =
      member.name + ' / ' + period.title;
    const body = document.getElementById('mgr-member-detail-list');
    body.innerHTML = '<p class="loading-text">提出内容を読み込み中…</p>';

    try {
      const result = await SupaAPI.getShiftsOf(period.id, member.id);
      const shifts = result.shifts || [];
      if (!shifts.length) {
        body.innerHTML = '<p class="info-text">提出明細がありません。</p>';
        return;
      }
      body.innerHTML = shifts.map(s => {
        const label = formatDateLabel(s.date);
        if (s.available) {
          return `
            <div class="confirm-item available">
              <span class="confirm-date">${label}</span>
              <span class="confirm-time">${s.start} 〜 ${s.end}</span>
            </div>`;
        }
        return `
          <div class="confirm-item unavailable">
            <span class="confirm-date">${label}</span>
            <span class="confirm-status">勤務不可</span>
          </div>`;
      }).join('');
    } catch (err) {
      console.error('[ManagerHome.openMember]', err);
      body.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  }
};

// ============================================================
// エントリーポイント
// ============================================================

async function initApp() {
  try {
    // 1. LIFF初期化
    await liff.init({ liffId: CONFIG_V2.LIFF_ID });

    // 2. 未ログインならリダイレクト（戻り後に再実行される）
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }

    // 3. Supabaseセッション確立（submit-v2 と同じ仕組み）
    SupaAPI.init();
    const result = await SupaAPI.login();
    if (result.status === 'need_registration') {
      // LINE未連携（プロフィール未作成）。第2段階でここにコード入力を差し込む。
      showScreen('unlinked');
      return;
    }

    // 4. 自分の所属を読み込んで role で分岐
    const me = await SupaAPI.getMe();
    MgrState.userId      = me.profile.id;
    MgrState.displayName = me.profile.display_name;
    MgrState.managed     = me.memberships.filter(
      m => m.role === 'admin' || m.role === 'manager');

    if (!me.memberships.length) {
      // 連携済みだが、どの店舗のメンバーにも登録されていない
      showScreen('unlinked');
      return;
    }
    if (!MgrState.managed.length) {
      // スタッフが誤って開いた → 中身は描画しない
      showScreen('not-manager');
      return;
    }

    MgrState.storeId = MgrState.managed[0].store_id;
    ManagerHome.showHome();

  } catch (err) {
    console.error('[initApp] 起動エラー:', err);
    showError(
      'アプリの起動に失敗しました。\n\n' +
      err.message + '\n\n' +
      'LINEアプリを再起動してお試しください。'
    );
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  const loadingScreen = document.getElementById('screen-loading');
  if (loadingScreen) loadingScreen.classList.add('active');
  initApp();
});
