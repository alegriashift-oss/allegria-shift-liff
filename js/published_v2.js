/**
 * 確定シフトの本人閲覧（Supabase版 v2）
 *
 * 店長が admin-v2.html で確定（公開）したシフトを、スタッフが
 * 期間一覧 → 日別リストで確認する。読み取り専用。
 * RLSにより、公開済み（status='published'）の行だけが見える。
 */
const PublishedViewer = {
  _periods: [],

  async init() {
    const container = document.getElementById('published-period-list');
    container.innerHTML = '<p class="loading-text">確定シフトを読み込み中…</p>';
    try {
      this._periods = await SupaAPI.getMyPublishedPeriods();
      container.innerHTML = this._periods.length
        ? this._periods.map((p, index) => `
            <button class="history-period-btn" onclick="PublishedViewer.open(${index})">
              <span>${escapeHtml(periodLabel(p))}</span>
              <span class="history-arrow">›</span>
            </button>
          `).join('')
        : '<p class="info-text">確定したシフトはまだありません。<br>店長がシフトを確定すると、ここに表示されます。</p>';
    } catch (err) {
      container.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  },

  async open(index) {
    const p = this._periods[index];
    if (!p) return;
    const vm = toPeriodVM(p);

    showScreen('published-detail');
    document.getElementById('published-detail-label').textContent = vm.label;
    const container = document.getElementById('published-detail-list');
    container.innerHTML = '<p class="loading-text">読み込み中…</p>';

    try {
      const rows = await SupaAPI.getMyPublishedShifts(p.id);
      const byDate = {};
      rows.forEach(r => { byDate[String(r.work_date)] = r; });

      container.innerHTML = this._datesBetween(vm.start, vm.end).map(date => {
        const r = byDate[date];
        const label = Calendar.formatDateLabel(date);
        if (r) {
          return `
            <div class="confirm-item available">
              <span class="confirm-date">${label}</span>
              <span class="confirm-time">${String(r.start_time).slice(0, 5)} 〜 ${String(r.end_time).slice(0, 5)}</span>
            </div>
          `;
        }
        return `
          <div class="confirm-item unavailable">
            <span class="confirm-date">${label}</span>
            <span class="confirm-status">休み</span>
          </div>
        `;
      }).join('');
    } catch (err) {
      container.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  },

  /** "YYYY-MM-DD"の開始日〜終了日を1日ずつ列挙する（タイムゾーンずれ防止のため手組み） */
  _datesBetween(start, end) {
    const dates = [];
    const s = start.split('-').map(Number);
    const e = end.split('-').map(Number);
    const cur = new Date(s[0], s[1] - 1, s[2]);
    const last = new Date(e[0], e[1] - 1, e[2]);
    while (cur <= last) {
      const m = String(cur.getMonth() + 1).padStart(2, '0');
      const d = String(cur.getDate()).padStart(2, '0');
      dates.push(cur.getFullYear() + '-' + m + '-' + d);
      cur.setDate(cur.getDate() + 1);
    }
    return dates;
  }
};
