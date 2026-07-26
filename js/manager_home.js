/**
 * アレグリア シフト管理ツール - 店長トップページ（manager-home.html 専用・v2）
 *
 * リッチメニュー「店長メニュー🔑」から起動する店長専用の入口。
 * 認証は submit-v2 / admin-v2 と同じ line-auth → Supabaseセッションを流用し、
 * store_members.role で描画を出し分ける（データ保護の本体はRLS＝is_manager_of()）。
 *
 * 2026-07 新UI: 提出状況カード最上位（ドーナツ進捗）・店舗切替カード（短縮名タブ）・
 * シフト表は中カード・補助機能は下部リスト型。検証ページ(manager-home-v2)から昇格。
 *
 * 2026-07-26 期間セレクタ: 受付中(open)だけを見る作りをやめ、
 * 「受付中」＋「直近で締め切られた期間」の最大2件から選べるようにした。
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
  managed    : [],    // 店長権限(admin/manager)を持つ所属 [{store_id, store_name, store_key, role, ...}]
  storeId    : null,  // 表示中の店舗
  periods    : [],    // 切替候補（表示順: 締切済み → 受付中）最大2件
  period     : null,  // 選択中の期間（periods の要素）または null
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

/**
 * 今日（日本時間）の "YYYY-MM-DD"。
 * 端末のタイムゾーンがJSTでなくても、期間の start_date（DATE型・JST基準）と
 * 文字列比較できる形で揃える。ISO日付なので辞書順比較＝日付順比較。
 */
function todayJst() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

/** deadline（timestamptz）→ 日本時間の "M/D"。取れなければ null */
function formatDeadlineShort(deadline) {
  if (!deadline) return null;
  // PostgRESTは "2026-08-10T14:59:00+00:00" だが、経路によっては
  // スペース区切り・"+00"（2桁だけのオフセット）で来ることがある。
  // どちらも Date が解釈できる形に正規化してから渡す。
  const iso = String(deadline)
    .replace(' ', 'T')
    .replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric'
  }).format(d);
  return parts.replace(/\s/g, '');  // "8/10"
}

/** 期間の状態ラベル（セレクタ用の長い表記） */
function periodStateLabel(period) {
  if (!period) return '';
  if (period.status === 'open') {
    const dl = formatDeadlineShort(period.deadline);
    return dl ? '受付中・締切' + dl : '受付中';
  }
  return '締切済み・シフト作成中';
}

/** 期間の状態ラベル（カード内チップ用の短い表記） */
function periodStateChip(period) {
  if (!period) return '';
  return period.status === 'open' ? '受付中' : '締切済み';
}

/**
 * 店舗切替タブ用の短縮表示名。
 *   1. store_key の明示マップを最優先（例: dummy01 → テスト店）
 *   2. 先頭のブランド名「アレグリア」と【…】注記を除去（例: アレグリア神保町 → 神保町）
 *   3. それでも6文字を超えるなら省略記号
 * 多店舗販売の恒久解は stores.short_name 列だが、現段階はフロント側で完結させる。
 */
const SHORT_STORE_NAMES = { dummy01: 'テスト店' };

function shortStoreName(membership) {
  const key = membership.store_key || '';
  if (SHORT_STORE_NAMES[key]) return SHORT_STORE_NAMES[key];
  let name = String(membership.store_name || '');
  name = name.replace(/^アレグリア\s*/, '').replace(/【[^】]*】/g, '').trim();
  if (!name) name = String(membership.store_name || '');
  return name.length > 6 ? name.slice(0, 6) + '…' : name;
}

// ============================================================
// 店長トップ本体
// ============================================================

const ManagerHome = {

  _selectedStore() {
    return MgrState.managed.find(m => m.store_id === MgrState.storeId) || null;
  },

  /** コンパクトヘッダー（店名・ログイン名のみ）を描画 */
  _renderHeader() {
    const store = this._selectedStore();
    const storeEl = document.getElementById('mgr-store-name');
    const userEl  = document.getElementById('mgr-user-name');
    if (storeEl) storeEl.textContent = store ? store.store_name : '';
    if (userEl)  userEl.textContent  = MgrState.displayName || '';
  },

  /** 店舗切替カード（掛け持ち店長のときだけ表示・短縮名タブ） */
  _renderStoreSwitch() {
    const card = document.getElementById('mgr-store-switch');
    if (!card) return;
    if (MgrState.managed.length < 2) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    card.innerHTML = `
      <p class="mgr-switch-title">🏪 店舗を切り替え</p>
      <div class="mgr-switch-tabs">` +
      MgrState.managed.map(m => `
        <button class="mgr-switch-tab${m.store_id === MgrState.storeId ? ' on' : ''}"
          onclick="ManagerHome.switchStore('${m.store_id}')">${escapeHtml(shortStoreName(m))}</button>
      `).join('') + `
      </div>`;
  },

  switchStore(storeId) {
    if (!MgrState.managed.some(m => m.store_id === storeId)) return;
    MgrState.storeId = storeId;
    this.showHome();
  },

  /**
   * 選択中の店の「シフト表を開く」カードを描画する。
   * spreadsheet_id と sheet_gid の両方がそろっている店だけカードを出し、
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
    // 白カード＋緑アウトラインの中ボタン（主役は提出状況カード）。
    holder.innerHTML = `
      <div class="mgr-panel mgr-sheet-panel">
        <span class="mgr-sheet-icon" aria-hidden="true">📊</span>
        <span class="mgr-sheet-body">
          <span class="mgr-sheet-title">シフト表を開く</span>
          <span class="mgr-sheet-sub">Googleスプレッドシートで開きます</span>
        </span>
        <a class="mgr-sheet-open" href="${url}" target="_blank" rel="noopener">開く ↗</a>
      </div>`;
  },

  /**
   * 既定で開く期間を決める。
   *   直近で締め切られた期間の start_date が今日より後（＝まだ勤務が始まっていない
   *   ＝これから組む期間）なら、そちらを選ぶ。そうでなければ受付中の期間。
   * 片方しか無ければそれを返す。
   */
  _defaultPeriod(open, closed) {
    if (!closed) return open;
    if (!open)   return closed;
    return closed.start_date > todayJst() ? closed : open;
  },

  /**
   * 期間セレクタ（締切済み / 受付中）。候補が1件以下のときは出さない。
   */
  _renderPeriodSwitch() {
    const card = document.getElementById('mgr-period-switch');
    if (!card) return;
    if (MgrState.periods.length < 2) {
      card.style.display = 'none';
      card.innerHTML = '';
      return;
    }
    card.style.display = '';
    const current = MgrState.period;
    card.innerHTML = `
      <p class="mgr-switch-title">🗓 表示する期間</p>
      <div class="mgr-period-tabs">` +
      MgrState.periods.map(p => {
        const on    = current && p.id === current.id;
        const state = periodStateLabel(p);
        return `
        <button class="mgr-period-tab${on ? ' on' : ''}"
          aria-pressed="${on ? 'true' : 'false'}"
          aria-label="${escapeHtml(p.title + '（' + state + '）')}"
          onclick="ManagerHome.switchPeriod('${p.id}')">
          <span class="mgr-period-tab-title">${escapeHtml(p.title)}</span>
          <span class="mgr-period-tab-state">${escapeHtml(state)}</span>
        </button>`;
      }).join('') + `
      </div>`;
  },

  /** セレクタから期間を切り替える（店舗・スタッフ一覧は据え置き、提出状況だけ引き直す） */
  switchPeriod(periodId) {
    const period = MgrState.periods.find(p => p.id === periodId);
    if (!period || (MgrState.period && MgrState.period.id === periodId)) return;
    MgrState.period = period;
    this._renderPeriodSwitch();
    this._renderSubmissionCard();
  },

  /**
   * 選択中の期間の提出状況カードを描画する。
   * 判定は submissions の有無のみ（submission_items は一覧では絶対に引かない）。
   */
  async _renderSubmissionCard() {
    const card   = document.getElementById('mgr-submission-card');
    const period = MgrState.period;
    const head   = `
        <div class="mgr-sub-head">
          <p class="mgr-panel-title">📋 提出状況</p>` +
      (period
        ? `<span class="mgr-period-chip">📅 ${escapeHtml(period.title)}（${escapeHtml(periodStateChip(period))}）</span>`
        : '') + `
        </div>`;

    if (!period) {
      card.innerHTML = head + '<p class="info-text">表示できる期間がありません。</p>';
      return;
    }

    card.innerHTML = head + '<p class="loading-text">提出状況を読み込み中…</p>';

    try {
      const submittedIds = await SupaAPI.getSubmittedUserIds(period.id);
      // 期間切替後に古いレスポンスが遅れて届いても上書きしない
      if (!MgrState.period || MgrState.period.id !== period.id) return;

      // 詳細一覧でも使うので状態に持たせる（再取得せず遷移できる）
      MgrState.staff = MgrState.staff.map(s => ({ ...s, submitted: submittedIds.has(s.id) }));

      const eligible  = MgrState.staff.length;
      const submitted = MgrState.staff.filter(s => s.submitted).length;
      const missing   = eligible - submitted;
      const pct       = eligible > 0 ? Math.round(submitted / eligible * 100) : 0;

      card.innerHTML = head + `
        <div class="mgr-sub-grid">
          <div class="mgr-donut" style="--pct:${pct}">
            <div class="mgr-donut-hole">
              <span class="mgr-donut-num">${submitted}</span>
              <span class="mgr-donut-den">/${eligible}名</span>
            </div>
          </div>
          <div class="mgr-stats">
            <div class="mgr-stat ok"><span class="mgr-dot"></span>提出済み<strong>${submitted}名</strong></div>
            <div class="mgr-stat ng"><span class="mgr-dot"></span>未提出<strong>${missing}名</strong></div>
          </div>
        </div>
        <button class="btn-primary" onclick="ManagerHome.openDetail()">提出状況の詳細を見る</button>
      `;
    } catch (err) {
      console.error('[ManagerHome._renderSubmissionCard]', err);
      card.innerHTML = head + `
        <p class="error-text">${escapeHtml(err.message)}</p>
        <button class="btn-secondary" onclick="ManagerHome.showHome()">再読み込み</button>
      `;
    }
  },

  /** ホーム画面（提出状況カードほか）を描画 */
  async showHome() {
    showScreen('home');
    this._renderHeader();
    this._renderStoreSwitch();
    this._renderSheetButton();

    // 店舗切替のたびに前の店の期間が残らないよう、先に空にしてから読み直す
    MgrState.periods = [];
    MgrState.period  = null;
    MgrState.staff   = [];
    this._renderPeriodSwitch();

    const card = document.getElementById('mgr-submission-card');
    card.innerHTML = '<p class="loading-text">提出状況を読み込み中…</p>';

    try {
      const storeId = MgrState.storeId;
      const { open, closed } = await SupaAPI.getManagerPeriods(storeId);
      const staff = await SupaAPI.getEligibleStaff(storeId);

      // 表示順は「締切済み（作成中）→ 受付中」。時系列でも締切済みが手前になる。
      MgrState.periods = [closed, open].filter(Boolean);
      MgrState.period  = this._defaultPeriod(open, closed);
      MgrState.staff   = staff.map(s => ({ ...s, submitted: false }));

      this._renderPeriodSwitch();
      await this._renderSubmissionCard();
    } catch (err) {
      console.error('[ManagerHome.showHome]', err);
      card.innerHTML = `
        <div class="mgr-sub-head">
          <p class="mgr-panel-title">📋 提出状況</p>
        </div>
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
    location.href = 'admin-v2.html?v=20260726-v3-period-selector&from=manager';
  },

  // --------------------------------------------------------
  // 提出状況の詳細一覧（現行と同一）
  // --------------------------------------------------------

  openDetail() {
    showScreen('detail');
    // 期間はセレクタで選ばれた MgrState.period をそのまま引き継ぐ（再取得しない）
    const period = MgrState.period;
    const labelEl = document.getElementById('mgr-detail-period');
    if (labelEl) {
      labelEl.textContent = period
        ? period.title + '（' + periodStateChip(period) + '）'
        : '';
    }

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
// エントリーポイント（現行と同一）
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
