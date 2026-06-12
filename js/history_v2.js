/**
 * 提出履歴の本人閲覧（Supabase版 v2）。
 * 詳細表示は入力画面と同じ Calendar を読み取り専用で再利用する。
 * 管理者向けの提出状況一覧は manager_v2.js（ManagerViewer）にある。
 */
const HistoryViewer = {
  _entries: [],

  async init() {
    const container = document.getElementById('history-period-list');
    container.innerHTML = '<p class="loading-text">提出履歴を読み込み中…</p>';
    try {
      this._entries = await SupaAPI.getMyHistory();
      container.innerHTML = this._entries.length
        ? this._entries.map((entry, index) => `
            <button class="history-period-btn" onclick="HistoryViewer.open(${index})">
              <span>${escapeHtml(periodLabel(entry.period))}</span>
              <span class="history-arrow">›</span>
            </button>
          `).join('')
        : '<p class="info-text">保存されている提出履歴はありません。</p>';
    } catch (err) {
      container.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  },

  async open(index) {
    const entry = this._entries[index];
    if (!entry) return;
    showScreen('calendar');
    document.getElementById('calendar-cards-container').innerHTML =
      '<p class="loading-text">提出済みシフトを読み込み中…</p>';
    try {
      const periodVM = toPeriodVM(entry.period);
      const result = await SupaAPI.getMyShifts(entry.period.id);
      Calendar.backAction = () => {
        showScreen('history');
        HistoryViewer.init();
      };
      Calendar.init(periodVM, result.shifts || [], true);
    } catch (err) {
      showError(err.message);
    }
  }
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
