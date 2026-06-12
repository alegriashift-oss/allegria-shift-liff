/**
 * アレグリア シフト管理ツール - メインモジュール（Supabase版 v2）
 *
 * GAS版 main.js のバックエンド呼び出しを SupaAPI（api_v2.js）に差し替えたもの。
 * 画面遷移・UI・操作感はGAS版と同一を維持する。
 *
 * ロード順: config_v2.js → api_v2.js → name_selector_v2.js → calendar.js
 *           → history_v2.js → manager_v2.js → main_v2.js
 * （calendar.js はGAS版をそのまま再利用。バックエンド依存がないため）
 */

// ============================================================
// アプリケーション状態
// ============================================================

const AppState = {
  userId      : null,   // Supabase auth uid（= profiles.id）
  displayName : null,   // メンバー本名（profilesから取得）
  memberships : [],     // 自分の所属 [{store_id, store_name, role, member_code, status}]
  store       : null,   // 提出可否判定用（所属が1つでもあればその store_id）
  role        : 'staff',
  selectedPeriod: null  // 現在選択中の期間VM
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

// ============================================================
// 期間VM（shift_periods の行 → 既存UIが期待する形へ変換）
// ============================================================

/**
 * DBの期間行をカレンダー・期間カードが使う形に変換する。
 * 既存UIの期待形: {id, label, start, end, deadline}（すべてYYYY-MM-DD）
 * v2では提出先店舗を持ち回るため storeId を追加。
 */
function toPeriodVM(p) {
  const membership = AppState.memberships.find(m => m.store_id === p.store_id);
  const storeName  = membership ? membership.store_name : '';
  const multiStore = AppState.memberships.length > 1;

  return {
    id      : p.id,
    storeId : p.store_id,
    label   : (multiStore && storeName ? storeName + ' / ' : '') + p.title,
    start   : String(p.start_date).slice(0, 10),
    end     : String(p.end_date).slice(0, 10),
    deadline: String(p.deadline).slice(0, 10)
  };
}

function periodLabel(p) {
  return toPeriodVM(p).label;
}

// ============================================================
// 期間選択画面
// ============================================================

const PeriodSelector = {

  _periods: [],

  async init() {
    const nameEl = document.getElementById('member-display-name');
    if (nameEl) nameEl.textContent = AppState.displayName || '';

    const container = document.getElementById('period-list-container');
    container.innerHTML = '<p class="loading-text">期間情報を読み込み中…</p>';

    try {
      const storeIds = AppState.memberships.map(m => m.store_id);
      const rows = await SupaAPI.getOpenPeriods(storeIds);

      if (!rows.length) {
        container.innerHTML =
          '<p class="info-text">現在は提出期間外です。<br>次の提出期間までお待ちください。</p>';
        return;
      }

      this._periods = rows.map(toPeriodVM);
      this._renderPeriods(this._periods);

    } catch (err) {
      container.innerHTML = `
        <p class="error-text">期間情報の読み込みに失敗しました。<br>${err.message}</p>
        <button class="btn-secondary" onclick="PeriodSelector.init()">再読み込み</button>
      `;
      console.error('[PeriodSelector] getOpenPeriods:', err);
    }
  },

  _renderPeriods(periods) {
    const container = document.getElementById('period-list-container');
    const today = new Date(); today.setHours(0, 0, 0, 0);

    if (periods.length === 0) {
      container.innerHTML = '<p class="info-text">現在、提出可能な期間はありません。</p>';
      return;
    }

    const html = periods.map((p, index) => {
      const deadline = new Date(p.deadline + 'T00:00:00');
      const isOverDeadline = today > deadline;

      return `
        <div class="period-card${isOverDeadline ? ' over-deadline' : ''}">
          <div class="period-label">${p.label}</div>
          <div class="period-deadline">
            締切: ${p.deadline.replace(/-/g, '/')}
            ${isOverDeadline ? '<span class="deadline-badge">期限超過</span>' : ''}
          </div>
          <button
            class="btn-primary"
            onclick="PeriodSelector.onSelect(${index})"
          >
            ${isOverDeadline ? '（遅れて）' : ''}シフトを提出する
          </button>
        </div>
      `;
    }).join('');

    container.innerHTML = html;
  },

  async onSelect(index) {
    const period = this._periods[index];
    if (!period) return;

    AppState.selectedPeriod = period;
    Calendar.backAction = null;

    showScreen('calendar');
    document.getElementById('calendar-cards-container').innerHTML =
      '<p class="loading-text">提出済みシフトを確認中…</p>';

    try {
      // 提出済みシフトがあれば初期値として渡す（再編集対応）
      const result = await SupaAPI.getMyShifts(period.id);
      Calendar.init(period, result.shifts || []);

    } catch (err) {
      // 取得失敗でも空のカレンダーで続行（初回提出の場合は正常）
      console.warn('[PeriodSelector] getMyShifts failed, continuing empty:', err);
      Calendar.init(period, []);
    }
  }

};

// ============================================================
// 確認画面
// ============================================================

const Confirmation = {

  currentPeriod: null,
  shifts: null,
  isOverDeadline: false,
  isSubmitting: false,

  init(period, shifts, isOverDeadline) {
    this.currentPeriod = period;
    this.shifts = shifts;
    this.isOverDeadline = isOverDeadline;
    this.isSubmitting = false;

    document.getElementById('confirm-period-label').textContent = period.label;

    const warningEl = document.getElementById('confirm-deadline-warning');
    if (warningEl) warningEl.style.display = isOverDeadline ? '' : 'none';

    this._renderShiftList(shifts);
    this._setSubmitting(false);
  },

  _renderShiftList(shifts) {
    const container = document.getElementById('confirm-shift-list');
    if (!container) return;

    container.innerHTML = shifts.map(s => {
      const label = Calendar.formatDateLabel(s.date);
      if (s.available) {
        return `
          <div class="confirm-item available">
            <span class="confirm-date">${label}</span>
            <span class="confirm-time">${s.start} 〜 ${s.end}</span>
          </div>
        `;
      } else {
        return `
          <div class="confirm-item unavailable">
            <span class="confirm-date">${label}</span>
            <span class="confirm-status">勤務不可</span>
          </div>
        `;
      }
    }).join('');
  },

  onBack() {
    if (this.isSubmitting) {
      showToast('送信中です。少し待ってから操作してください');
      return;
    }

    const confirmBtn = document.getElementById('btn-go-to-confirm');
    const viewBadge = document.getElementById('calendar-view-only-badge');
    if (confirmBtn) confirmBtn.style.display = '';
    if (viewBadge) viewBadge.style.display = 'none';

    showScreen('calendar');
  },

  async onSubmit() {
    if (this.isSubmitting) return;
    this._setSubmitting(true);

    try {
      await SupaAPI.submitShift(this.currentPeriod, this.shifts);
      showScreen('complete');

    } catch (err) {
      alert('提出に失敗しました。もう一度お試しください。\n' + err.message);
      console.error('[Confirmation] submitShift:', err);
      this._setSubmitting(false);
    }
  },

  _setSubmitting(isSubmitting) {
    this.isSubmitting = isSubmitting;

    const submitBtn = document.getElementById('confirm-submit-btn');
    if (submitBtn) {
      submitBtn.disabled = isSubmitting;
      submitBtn.textContent = isSubmitting ? '送信中…' : '提出する ✓';
    }

    const backBtn = document.getElementById('confirm-back-btn');
    if (backBtn) {
      backBtn.disabled = isSubmitting;
    }
  }
};

// ============================================================
// 完了画面
// ============================================================

async function closeApp() {
  var btn = document.getElementById('close-page-btn');
  var help = document.getElementById('close-page-help');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '閉じています…';
  }
  if (help) help.style.display = 'none';

  try {
    if (window.liff && typeof liff.isInClient === 'function' && liff.isInClient()) {
      liff.closeWindow();
      setTimeout(function() {
        if (help) {
          help.textContent = '閉じない場合は、画面右上の×で閉じてください。';
          help.style.display = '';
        }
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'このページを閉じる';
        }
      }, 1200);
      return;
    }
  } catch (err) {
    console.warn('[closeApp] liff.closeWindow failed:', err);
  }

  try {
    window.close();
  } catch (err) {
    console.warn('[closeApp] window.close failed:', err);
  }

  if (help) {
    help.textContent = 'LINEアプリ内で開くと、このボタンで閉じられます。外部ブラウザでは右上の×で閉じてください。';
    help.style.display = '';
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'このページを閉じる';
  }
}

// ============================================================
// ホーム画面
// ============================================================

const Home = {
  show() {
    const nameEl = document.getElementById('home-member-name');
    const manageBtn = document.getElementById('home-manage-btn');
    const submitBtn = document.getElementById('home-submit-btn');
    const publishedBtn = document.getElementById('home-published-btn');
    if (nameEl) nameEl.textContent = AppState.displayName || '';
    if (submitBtn) {
      submitBtn.style.display = AppState.store ? '' : 'none';
    }
    if (publishedBtn) {
      // アレグリア運用ではシフトはExcelで管理するため非表示。
      // 商品化で確定シフト配信を使う際は AppState.store ? '' : 'none' に戻す
      publishedBtn.style.display = 'none';
    }
    if (manageBtn) {
      manageBtn.style.display = ManagerViewer.managedStoreIds().length ? '' : 'none';
    }
    const membersBtn = document.getElementById('home-members-btn');
    if (membersBtn) {
      membersBtn.style.display = ManagerViewer.managedStoreIds().length ? '' : 'none';
    }
    showScreen('home');
  },

  openSubmit() {
    if (!AppState.store) {
      showToast('シフト提出先の店舗が設定されていません');
      return;
    }
    showScreen('period-selector');
    PeriodSelector.init();
  },

  openHistory() {
    showScreen('history');
    HistoryViewer.init();
  },

  openPublished() {
    showScreen('published');
    PublishedViewer.init();
  },

  openManage() {
    showScreen('manage');
    ManagerViewer.init();
  }
};

// ============================================================
// エントリーポイント
// ============================================================

/**
 * ログイン完了後の共通処理。
 * 自分のプロフィール・所属を読み込んでホーム画面を表示する。
 * （name_selector_v2.js の登録完了時にも呼ばれる）
 */
async function enterHome() {
  const me = await SupaAPI.getMe();

  AppState.userId      = me.profile.id;
  AppState.displayName = me.profile.display_name;
  AppState.memberships = me.memberships;
  AppState.store       = me.memberships.length ? me.memberships[0].store_id : null;
  AppState.role        = me.memberships.some(m => m.role === 'admin') ? 'admin' : 'staff';

  Home.show();
}

async function initApp() {
  try {
    // 1. LIFF SDK を初期化
    await liff.init({ liffId: CONFIG_V2.LIFF_ID });

    // 2. LINEにログインしていなければリダイレクト
    if (!liff.isLoggedIn()) {
      liff.login();
      return; // リダイレクト後に再実行されるのでここで終了
    }

    // 3. Supabaseセッションを確立（既存セッションがあれば再利用）
    SupaAPI.init();
    const result = await SupaAPI.login();

    if (result.status === 'need_registration') {
      // 未連携 → 名前選択画面へ
      showScreen('name-selector');
      NameSelector.init(result.candidates || []);
      return;
    }

    // 4. 連携済み → 自分の情報を読み込んでホームへ
    await enterHome();

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
