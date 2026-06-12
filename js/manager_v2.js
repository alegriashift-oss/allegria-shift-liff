/**
 * 管理者向け 店舗の提出状況ビュー（Supabase版 v2）
 *
 * GAS版 history.js 内 ManagerViewer のバックエンドを SupaAPI に差し替えたもの。
 * 画面・要素ID・CSSクラスはGAS版と同一（screen-manage / manage-body）。
 *
 * GAS版との差分: v2では期間が店舗ごとの行になっており、期間ラベルに
 * 店舗名が付く（toPeriodVM）ため、店舗選択プルダウンは期間選択に統合した。
 */
const ManagerViewer = {
  _periods : [],    // 期間VM（toPeriodVM済み）の配列
  _periodId: null,  // 選択中の期間ID
  _members : [],    // [{id, name, submitted}]

  /** 自分が店長権限（admin/manager）を持つ店舗IDの一覧 */
  managedStoreIds() {
    return AppState.memberships
      .filter(m => m.role === 'admin' || m.role === 'manager')
      .map(m => m.store_id);
  },

  async init() {
    const container = document.getElementById('manage-body');
    container.innerHTML = '<p class="loading-text">提出状況を読み込み中…</p>';
    try {
      const rows = await SupaAPI.getManagePeriods(this.managedStoreIds());
      this._periods = rows.map(toPeriodVM);
      if (!this._periods.length) {
        container.innerHTML = '<p class="info-text">表示できる提出期間はありません。</p>';
        return;
      }
      // 前回選択した期間が消えていたら先頭（最新）に戻す
      if (!this._periods.some(p => p.id === this._periodId)) {
        this._periodId = this._periods[0].id;
      }
      await this.loadOverview();
    } catch (err) {
      container.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  },

  _selectedPeriod() {
    return this._periods.find(p => p.id === this._periodId) || null;
  },

  async loadOverview() {
    const container = document.getElementById('manage-body');
    container.innerHTML = '<p class="loading-text">提出状況を読み込み中…</p>';
    try {
      const period = this._selectedPeriod();
      if (!period) throw new Error('期間が選択されていません');

      this._members = await SupaAPI.getManageOverview(period);
      const submittedCount = this._members.filter(member => member.submitted).length;

      container.innerHTML = `
        <label class="field-label" for="manage-period">対象期間</label>
        <select id="manage-period" class="filter-select" onchange="ManagerViewer.onPeriodChange(this.value)">
          ${this._periods.map(p => `<option value="${p.id}"${p.id === this._periodId ? ' selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
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
    } catch (err) {
      container.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  },

  async onPeriodChange(periodId) {
    this._periodId = periodId;
    await this.loadOverview();
  },

  async openMember(index) {
    const member = this._members[index];
    if (!member || !member.submitted) {
      showToast('このスタッフはまだ提出していません');
      return;
    }
    const period = this._selectedPeriod();
    showScreen('calendar');
    document.getElementById('calendar-cards-container').innerHTML =
      '<p class="loading-text">提出済みシフトを読み込み中…</p>';
    try {
      const result = await SupaAPI.getShiftsOf(period.id, member.id);
      Calendar.backAction = () => {
        showScreen('manage');
        ManagerViewer.loadOverview();
      };
      Calendar.init(period, result.shifts || [], true);
      document.getElementById('calendar-period-label').textContent =
        member.name + ' / ' + period.label;
    } catch (err) {
      showError(err.message);
    }
  }
};
