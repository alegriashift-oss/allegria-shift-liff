/**
 * 提出履歴の本人閲覧と管理者閲覧。
 * 詳細表示は入力画面と同じ Calendar を読み取り専用で再利用する。
 */
const HistoryViewer = {
  _periods: [],

  async init() {
    const container = document.getElementById('history-period-list');
    container.innerHTML = '<p class="loading-text">提出履歴を読み込み中…</p>';
    try {
      const result = await API.getMyHistory(AppState.userId);
      if (!result.ok) throw new Error(result.error || '提出履歴の取得に失敗しました');
      this._periods = result.periods || [];
      container.innerHTML = this._periods.length
        ? this._periods.map((period, index) => `
            <button class="history-period-btn" onclick="HistoryViewer.open(${index})">
              <span>${escapeHtml(period.label)}</span>
              <span class="history-arrow">›</span>
            </button>
          `).join('')
        : '<p class="info-text">保存されている提出履歴はありません。</p>';
    } catch (err) {
      container.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  },

  async open(index) {
    const period = this._periods[index];
    if (!period) return;
    showScreen('calendar');
    document.getElementById('calendar-cards-container').innerHTML =
      '<p class="loading-text">提出済みシフトを読み込み中…</p>';
    try {
      const result = await API.getMyHistoryDetail(AppState.userId, period.id);
      if (!result.ok) throw new Error(result.error || '提出履歴の取得に失敗しました');
      Calendar.backAction = () => {
        showScreen('history');
        HistoryViewer.init();
      };
      Calendar.init(result.period, result.shifts || [], true);
    } catch (err) {
      showError(err.message);
    }
  }
};

const ManagerViewer = {
  _periods: [],
  _period: null,
  _storeId: '',
  _members: [],

  async init() {
    const container = document.getElementById('manage-body');
    container.innerHTML = '<p class="loading-text">提出状況を読み込み中…</p>';
    try {
      const result = await API.getManagePeriods(AppState.userId);
      if (!result.ok) throw new Error(result.error || '提出期間の取得に失敗しました');
      this._periods = result.periods || [];
      if (!this._periods.length) {
        container.innerHTML = '<p class="info-text">保存されている提出履歴はありません。</p>';
        return;
      }
      this._period = this._period || this._periods[0].id;
      await this.loadOverview();
    } catch (err) {
      container.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  },

  async loadOverview() {
    const container = document.getElementById('manage-body');
    container.innerHTML = '<p class="loading-text">提出状況を読み込み中…</p>';
    const result = await API.getManageOverview(AppState.userId, this._period, this._storeId);
    if (!result.ok) throw new Error(result.error || '提出状況の取得に失敗しました');
    this._storeId = result.selectedStore || '';
    this._members = result.members || [];
    const submittedCount = this._members.filter(member => member.submitted).length;

    container.innerHTML = `
      <label class="field-label" for="manage-period">対象期間</label>
      <select id="manage-period" class="filter-select" onchange="ManagerViewer.onPeriodChange(this.value)">
        ${this._periods.map(period => `<option value="${period.id}"${period.id === this._period ? ' selected' : ''}>${escapeHtml(period.label)}</option>`).join('')}
      </select>
      <label class="field-label" for="manage-store">店舗</label>
      <select id="manage-store" class="filter-select" onchange="ManagerViewer.onStoreChange(this.value)">
        ${(result.stores || []).map(store => `<option value="${store.id}"${store.id === this._storeId ? ' selected' : ''}>${escapeHtml(store.name)}</option>`).join('')}
      </select>
      <p class="manage-summary">提出済み ${submittedCount}名 / ${this._members.length}名</p>
      <div class="manage-member-list">
        ${this._members.map((member, index) => `
          <button class="manage-member-btn" onclick="ManagerViewer.openMember(${index})">
            <span>${escapeHtml(member.name)}</span>
            <span class="${member.submitted ? 'status-submitted' : 'status-missing'}">${member.submitted ? '提出済み' : '未提出'}</span>
          </button>
        `).join('')}
      </div>
    `;
  },

  async onPeriodChange(period) {
    this._period = period;
    await this.loadOverview();
  },

  async onStoreChange(storeId) {
    this._storeId = storeId;
    await this.loadOverview();
  },

  async openMember(index) {
    const member = this._members[index];
    if (!member || !member.submitted) {
      showToast('このスタッフはまだ提出していません');
      return;
    }
    showScreen('calendar');
    document.getElementById('calendar-cards-container').innerHTML =
      '<p class="loading-text">提出済みシフトを読み込み中…</p>';
    try {
      const result = await API.getManageDetail(AppState.userId, this._period, member.id);
      if (!result.ok) throw new Error(result.error || '提出履歴の取得に失敗しました');
      Calendar.backAction = () => {
        showScreen('manage');
        ManagerViewer.loadOverview();
      };
      Calendar.init(result.period, result.shifts || [], true);
      document.getElementById('calendar-period-label').textContent =
        result.member.name + ' / ' + result.period.label;
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
