/**
 * アレグリア シフト管理ツール - メインモジュール
 *
 * 役割:
 *   1. LIFF SDK の初期化
 *   2. アプリ全体の状態 (AppState) を管理
 *   3. 画面遷移のコントロール (showScreen)
 *   4. 期間選択画面 (PeriodSelector) の処理
 *   5. 確認画面 (Confirmation) の処理
 *   6. 完了画面の処理
 *
 * ロード順: config.js → api.js → name_selector.js → calendar.js → main.js
 */

// ============================================================
// アプリケーション状態
// ============================================================

/**
 * セッション中に共有するグローバル状態。
 * 各モジュールはこのオブジェクトを参照・更新して連携する。
 */
const AppState = {
  userId: null,   // LINE User ID（liff.getProfile() から取得）
  displayName: null,   // メンバー本名（GASから取得）
  store: null,   // 所属店舗 ('jimbocho' | 'shibuya')
  selectedPeriod: null // 現在選択中の期間オブジェクト
};

// ============================================================
// 汎用ユーティリティ
// ============================================================

/**
 * 指定スクリーンだけを表示し、ほかは非表示にする
 * @param {string} screenId - "screen-" プレフィックスを除いたID
 */
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

/**
 * 画面下部にトースト通知を一時表示する
 * @param {string} message  - 表示するメッセージ
 * @param {number} duration - 表示時間(ms)、デフォルト 3000ms
 */
function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), duration);
}

/**
 * エラー画面を表示する
 * @param {string} message - エラーメッセージ
 */
function showError(message) {
  const el = document.getElementById('error-message');
  if (el) el.textContent = message;
  showScreen('error');
}

// ============================================================
// 期間選択画面
// ============================================================

const PeriodSelector = {

  // GASから取得した期間リスト（クリック時の参照用）
  _periods: [],

  /**
   * 期間選択画面を初期化・描画
   */
  async init() {
    // ウェルカムメッセージのユーザー名を更新
    const nameEl = document.getElementById('member-display-name');
    if (nameEl) nameEl.textContent = AppState.displayName || '';

    const container = document.getElementById('period-list-container');
    container.innerHTML = '<p class="loading-text">期間情報を読み込み中…</p>';

    try {
      const result = await API.getPeriods();

      if (!result.ok) {
        throw new Error(result.error || '期間情報の取得に失敗しました');
      }

      this._periods = result.periods || [];
      this._renderPeriods(this._periods);

    } catch (err) {
      container.innerHTML = `
        <p class="error-text">期間情報の読み込みに失敗しました。<br>${err.message}</p>
        <button class="btn-secondary" onclick="PeriodSelector.init()">再読み込み</button>
      `;
      console.error('[PeriodSelector] getPeriods:', err);
    }
  },

  /**
   * 期間カードを描画
   * 提出可能な期間（isOpen=true）と過去期間を分けて表示する
   * @param {Array} periods
   */
  _renderPeriods(periods) {
    const container = document.getElementById('period-list-container');
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const openPeriods = periods.filter(p => p.isOpen);
    const pastPeriods = periods.filter(p => !p.isOpen);

    let html = '';

    if (openPeriods.length === 0) {
      html += '<p class="info-text">現在、提出可能な期間はありません。</p>';
    } else {
      html += openPeriods.map((p, localIdx) => {
        const globalIdx = periods.indexOf(p);
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
              onclick="PeriodSelector.onSelect(${globalIdx})"
            >
              ${isOverDeadline ? '（遅れて）' : ''}シフトを提出する
            </button>
          </div>
        `;
      }).join('');
    }

    // 過去の提出確認セクション
    if (pastPeriods.length > 0) {
      html += `
        <div class="past-section">
          <h3 class="section-heading">過去の提出を確認</h3>
          ${pastPeriods.slice(0, 3).map(p => {
        const globalIdx = periods.indexOf(p);
        const fmt = d => { const [, m, day] = d.split('-'); return `${parseInt(m)}/${parseInt(day)}`; };
        const dateRange = `${fmt(p.start)}〜${fmt(p.end)}`;
        return `
              <div class="period-card past">
                <div class="period-label">
                  ${p.label}<br>
                  <span class="period-date-range">${dateRange}</span>
                </div>
                <button
                  class="btn-secondary btn-sm"
                  onclick="PeriodSelector.onViewPast(${globalIdx})"
                >確認する</button>
              </div>
            `;
      }).join('')}
        </div>
      `;
    }

    container.innerHTML = html;
  },

  /**
   * 期間を選択して提出フローを開始
   * @param {number} index - this._periods のインデックス
   */
  async onSelect(index) {
    const period = this._periods[index];
    if (!period) return;

    AppState.selectedPeriod = period;

    // カレンダー画面に切り替えてローディング状態を表示
    showScreen('calendar');
    document.getElementById('calendar-cards-container').innerHTML =
      '<p class="loading-text">提出済みシフトを確認中…</p>';

    try {
      // 提出済みシフトがあれば初期値として渡す（再編集対応）
      const result = await API.getMyShifts(AppState.userId, period.id);
      const existingShifts = (result.ok && result.shifts) ? result.shifts : [];

      Calendar.init(period, existingShifts);

    } catch (err) {
      // 取得失敗でも空のカレンダーで続行（初回提出の場合は正常）
      console.warn('[PeriodSelector] getMyShifts failed, continuing empty:', err);
      Calendar.init(period, []);
    }
  },

  /**
   * 過去の期間を読み取り専用で確認
   * カレンダー画面を「閲覧モード」で開く（確認ボタンを非表示）
   * @param {number} index
   */
  async onViewPast(index) {
    const period = this._periods[index];
    if (!period) return;

    AppState.selectedPeriod = period;
    showScreen('calendar');
    document.getElementById('calendar-cards-container').innerHTML =
      '<p class="loading-text">シフトを読み込み中…</p>';

    try {
      const result = await API.getMyShifts(AppState.userId, period.id);
      const shifts = (result.ok && result.shifts) ? result.shifts : [];

      Calendar.init(period, shifts);

      // 過去期間は「確認画面へ」を非表示にして読み取り専用と明示
      const confirmBtn = document.getElementById('btn-go-to-confirm');
      if (confirmBtn) confirmBtn.style.display = 'none';

      const viewBadge = document.getElementById('calendar-view-only-badge');
      if (viewBadge) viewBadge.style.display = '';

    } catch (err) {
      alert('シフトの読み込みに失敗しました。\n' + err.message);
      showScreen('period-selector');
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

  /**
   * 確認画面を初期化・描画
   * @param {Object}  period         - 期間情報
   * @param {Array}   shifts         - バリデーション済みシフトデータ
   * @param {boolean} isOverDeadline - 期限超過かどうか
   */
  init(period, shifts, isOverDeadline) {
    this.currentPeriod = period;
    this.shifts = shifts;
    this.isOverDeadline = isOverDeadline;

    document.getElementById('confirm-period-label').textContent = period.label;

    // 期限超過の警告
    const warningEl = document.getElementById('confirm-deadline-warning');
    if (warningEl) warningEl.style.display = isOverDeadline ? '' : 'none';

    this._renderShiftList(shifts);
  },

  /**
   * シフト一覧を描画
   * @param {Array} shifts
   */
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

  /** 「修正する」ボタン → カレンダー画面に戻る */
  onBack() {
    // 確認画面から戻った場合は「確認画面へ」ボタンを再表示
    const confirmBtn = document.getElementById('btn-go-to-confirm');
    const viewBadge = document.getElementById('calendar-view-only-badge');
    if (confirmBtn) confirmBtn.style.display = '';
    if (viewBadge) viewBadge.style.display = 'none';

    showScreen('calendar');
  },

  /** 「提出する」ボタン */
  async onSubmit() {
    const submitBtn = document.getElementById('confirm-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = '送信中…';

    try {
      const result = await API.submitShift(
        AppState.userId,
        this.currentPeriod.id,
        this.shifts
      );

      if (!result.ok) {
        throw new Error(result.error || '提出に失敗しました');
      }

      showScreen('complete');

    } catch (err) {
      alert('提出に失敗しました。もう一度お試しください。\n' + err.message);
      console.error('[Confirmation] submitShift:', err);
      submitBtn.disabled = false;
      submitBtn.textContent = '提出する';
    }
  }
};

// ============================================================
// 完了画面
// ============================================================

/**
 * 「LINEに戻る」ボタン
 * LIFF の closeWindow() を呼んでアプリを閉じる
 */
function closeApp() {
  if (liff.isInClient()) {
    liff.closeWindow();
  } else {
    // ブラウザで開いている場合（開発中など）
    alert('LINEアプリ内で開いてください。');
  }
}

// ============================================================
// エントリーポイント
// ============================================================

/**
 * アプリを起動する
 * LIFF SDK の初期化から始めて、登録状況に応じて最初の画面を決定する
 */
async function initApp() {
  try {
    // 1. LIFF SDK を初期化
    await liff.init({ liffId: CONFIG.LIFF_ID });

    // 2. LINEにログインしていなければリダイレクト
    if (!liff.isLoggedIn()) {
      liff.login();
      return; // リダイレクト後に再実行されるのでここで終了
    }

    // 3. LINEプロフィールを取得してUserIDを保存
    const profile = await liff.getProfile();
    AppState.userId = profile.userId;

    // 4. GASでメンバー登録済みかチェック
    const memberResult = await API.checkMember(AppState.userId);

    if (!memberResult.ok) {
      throw new Error(memberResult.error || 'メンバー情報の確認に失敗しました');
    }

    if (memberResult.registered) {
      // 登録済み → 期間選択画面へ
      AppState.displayName = memberResult.member.name;
      AppState.store = memberResult.member.store;

      showScreen('period-selector');
      PeriodSelector.init();
    } else {
      // 未登録 → 名前選択画面へ
      showScreen('name-selector');
      NameSelector.init();
    }

  } catch (err) {
    console.error('[initApp] 起動エラー:', err);
    showError(
      'アプリの起動に失敗しました。\n\n' +
      err.message + '\n\n' +
      'LINEアプリを再起動してお試しください。'
    );
  }
}

// DOMの読み込み完了後にアプリを起動
document.addEventListener('DOMContentLoaded', () => {
  // 起動直後は screen-loading のみ表示（HTMLにactiveが残っていても上書き）
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  const loadingScreen = document.getElementById('screen-loading');
  if (loadingScreen) loadingScreen.classList.add('active');
  initApp();
});
