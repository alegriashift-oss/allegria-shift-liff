/**
 * アレグリア シフト管理ツール - カレンダー入力画面モジュール
 *
 * 期間内の各日付をカード形式で表示し、勤務可否と時刻を入力させる。
 *
 * データ構造:
 *   this.shifts[date] = { available: boolean, start: "HH:MM", end: "HH:MM" }
 *   日付は "YYYY-MM-DD" 形式で統一。
 */
const Calendar = {

  // 現在選択中の期間情報 { id, label, start, end, deadline }
  currentPeriod: null,

  // 入力されたシフトデータ。key=日付(YYYY-MM-DD)、value={available,start,end}
  shifts: {},

  // 時刻の選択肢 "HH:MM" 形式（10:00〜23:00、30分刻み = 27項目）
  TIME_OPTIONS: (() => {
    const opts = [];
    for (let h = 10; h <= 23; h++) {
      opts.push(`${String(h).padStart(2, '0')}:00`);
      if (h < 23) opts.push(`${String(h).padStart(2, '0')}:30`);
    }
    return opts; // ["10:00","10:30","11:00",...,"22:30","23:00"]
  })(),

  // デフォルトの開始・終了時刻
  DEFAULT_START : '10:00',
  DEFAULT_END   : '15:00',

  // ============================================================
  // 初期化
  // ============================================================

  /**
   * カレンダー画面を初期化
   * @param {Object} period          - 期間情報 {id, label, start, end, deadline}
   * @param {Array}  existingShifts  - 提出済みシフト（再編集時のみ渡す）
   */
  init(period, existingShifts = []) {
    this.currentPeriod = period;
    this.shifts = {};

    // 提出済みシフトを shifts オブジェクトへ変換（再編集時の初期値）
    existingShifts.forEach(s => {
      this.shifts[s.date] = {
        available : s.available,
        start     : s.start || this.DEFAULT_START,
        end       : s.end   || this.DEFAULT_END
      };
    });

    // ヘッダーの期間ラベルを更新
    document.getElementById('calendar-period-label').textContent = period.label;

    // 期限超過チェック・警告表示
    this._checkDeadline(period.deadline);

    // 全日付のカードを描画
    this._renderCalendar(period);
  },

  // ============================================================
  // 描画
  // ============================================================

  /**
   * 期間内の全日付カードをコンテナに描画
   * @param {Object} period
   */
  _renderCalendar(period) {
    const container = document.getElementById('calendar-cards-container');
    const dates     = this._getDatesInRange(period.start, period.end);

    container.innerHTML = dates.map(date => this._createCardHtml(date)).join('');
  },

  /**
   * 1日分のカードHTMLを生成
   * @param {string} date - YYYY-MM-DD
   * @returns {string} HTML文字列
   */
  _createCardHtml(date) {
    // 未入力日は「勤務可能、10:00〜15:00」をデフォルトとする
    const shift      = this.shifts[date] || { available: true, start: this.DEFAULT_START, end: this.DEFAULT_END };
    const isAvail    = shift.available;
    const dayLabel   = this.formatDateLabel(date);

    // 時刻オプションのHTML（選択状態を反映）
    const startOpts = this._buildTimeOptions(shift.start);
    const endOpts   = this._buildTimeOptions(shift.end);

    return `
      <div class="date-card" data-date="${date}">

        <!-- 日付ヘッダー -->
        <div class="date-card-header">
          <span class="date-label">${dayLabel}</span>
        </div>

        <!-- 勤務可能 / 勤務不可 トグルボタン -->
        <div class="availability-toggle" role="group" aria-label="勤務可否">
          <button
            class="toggle-btn ${isAvail ? 'active available' : ''}"
            onclick="Calendar.onToggle('${date}', true)"
            aria-pressed="${isAvail}"
          >勤務可能</button>
          <button
            class="toggle-btn ${!isAvail ? 'active unavailable' : ''}"
            onclick="Calendar.onToggle('${date}', false)"
            aria-pressed="${!isAvail}"
          >勤務不可</button>
        </div>

        <!-- 時刻入力（勤務不可のときは非表示） -->
        <div class="time-inputs" id="time-inputs-${date}" ${isAvail ? '' : 'style="display:none"'}>
          <div class="time-row">
            <label class="time-label" for="start-${date}">開始</label>
            <select
              class="time-select start-time"
              id="start-${date}"
              data-date="${date}"
              onchange="Calendar.onTimeChange('${date}')"
            >${startOpts}</select>
          </div>
          <div class="time-row">
            <label class="time-label" for="end-${date}">終了</label>
            <select
              class="time-select end-time"
              id="end-${date}"
              data-date="${date}"
              onchange="Calendar.onTimeChange('${date}')"
            >${endOpts}</select>
          </div>
          <!-- バリデーションエラー表示 -->
          <p class="time-error" id="time-error-${date}" style="display:none">
            ⚠ 開始時刻は終了時刻より前にしてください
          </p>
        </div>

      </div>
    `;
  },

  /**
   * 時刻セレクトの <option> 群を生成
   * @param {string} selectedTime - 現在の選択値 "HH:MM"
   * @returns {string} HTML
   */
  _buildTimeOptions(selectedTime) {
    return this.TIME_OPTIONS.map(t =>
      `<option value="${t}"${t === selectedTime ? ' selected' : ''}>${t}</option>`
    ).join('');
  },

  // ============================================================
  // イベントハンドラ
  // ============================================================

  /**
   * 勤務可否トグルが押されたとき
   * @param {string}  date      - YYYY-MM-DD
   * @param {boolean} available - true=勤務可能
   */
  onToggle(date, available) {
    // データを更新
    if (!this.shifts[date]) {
      this.shifts[date] = { available, start: this.DEFAULT_START, end: this.DEFAULT_END };
    } else {
      this.shifts[date].available = available;
    }

    // ボタンのスタイルを更新
    const card = document.querySelector(`.date-card[data-date="${date}"]`);
    if (!card) return;

    card.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.classList.remove('active', 'available', 'unavailable');
      btn.removeAttribute('aria-pressed');
    });

    const activeBtn = card.querySelector(`.toggle-btn:nth-child(${available ? 1 : 2})`);
    if (activeBtn) {
      activeBtn.classList.add('active', available ? 'available' : 'unavailable');
      activeBtn.setAttribute('aria-pressed', 'true');
    }

    // 時刻入力の表示/非表示
    const timeInputs = document.getElementById(`time-inputs-${date}`);
    if (timeInputs) timeInputs.style.display = available ? '' : 'none';

    // 勤務不可にしたらバリデーションエラーをリセット
    if (!available) {
      const errEl = document.getElementById(`time-error-${date}`);
      if (errEl) errEl.style.display = 'none';
    }
  },

  /**
   * 時刻セレクトが変更されたとき
   * shifts を更新してバリデーションを実行
   * @param {string} date - YYYY-MM-DD
   */
  onTimeChange(date) {
    const startEl = document.getElementById(`start-${date}`);
    const endEl   = document.getElementById(`end-${date}`);
    const errEl   = document.getElementById(`time-error-${date}`);
    if (!startEl || !endEl) return;

    const start = startEl.value;
    const end   = endEl.value;

    // データを更新
    if (!this.shifts[date]) {
      this.shifts[date] = { available: true, start, end };
    } else {
      this.shifts[date].start = start;
      this.shifts[date].end   = end;
    }

    // バリデーション: 開始 < 終了（文字列比較で OK、"HH:MM" 形式は辞書順=時刻順）
    const isInvalid = start >= end;
    if (errEl) errEl.style.display = isInvalid ? '' : 'none';
    startEl.classList.toggle('input-error', isInvalid);
    endEl.classList.toggle('input-error', isInvalid);
  },

  // ============================================================
  // ショートカット
  // ============================================================

  /**
   * 「すべて勤務不可」ボタン
   * 全日付を勤務不可にする
   */
  setAllUnavailable() {
    document.querySelectorAll('.date-card').forEach(card => {
      this.onToggle(card.dataset.date, false);
    });
    showToast('すべての日を勤務不可に設定しました');
  },

  /**
   * 「先週と同じ」ボタン
   * 前の期間のシフトを取得し、同じ曜日のシフトを現在の期間に適用する
   */
  async applySameAsLastWeek() {
    const btn = document.getElementById('btn-same-as-last-week');
    if (!btn) return;
    btn.disabled    = true;
    btn.textContent = '取得中…';

    try {
      // 全期間を取得して「現在の期間の1つ前」を特定
      const periodsResult = await API.getPeriods();
      if (!periodsResult.success || !periodsResult.periods) {
        throw new Error('期間情報の取得に失敗しました');
      }

      const allPeriods    = periodsResult.periods;
      const currentIdx    = allPeriods.findIndex(p => p.id === this.currentPeriod.id);

      if (currentIdx <= 0) {
        alert('前の期間のデータがありません。');
        return;
      }

      const prevPeriod     = allPeriods[currentIdx - 1];
      const shiftsResult   = await API.getMyShifts(AppState.userId, prevPeriod.id);

      if (!shiftsResult.success || !shiftsResult.shifts || shiftsResult.shifts.length === 0) {
        alert(`「${prevPeriod.label}」のシフトデータがありません。`);
        return;
      }

      // 曜日 (0=日〜6=土) → シフト情報 のマップを作成
      const dowMap = {};
      shiftsResult.shifts.forEach(s => {
        const dow = new Date(s.date + 'T00:00:00').getDay();
        dowMap[dow] = {
          available : s.available,
          start     : s.start || this.DEFAULT_START,
          end       : s.end   || this.DEFAULT_END
        };
      });

      // 現在の期間の各日付に同曜日のシフトを適用
      const dates         = this._getDatesInRange(this.currentPeriod.start, this.currentPeriod.end);
      let   appliedCount  = 0;

      dates.forEach(date => {
        const dow   = new Date(date + 'T00:00:00').getDay();
        const prev  = dowMap[dow];
        if (prev === undefined) return;

        // トグルを更新（UIも同時に更新される）
        this.onToggle(date, prev.available);

        if (prev.available) {
          // セレクトの値を手動で設定してからデータを更新
          const startEl = document.getElementById(`start-${date}`);
          const endEl   = document.getElementById(`end-${date}`);
          if (startEl) startEl.value = prev.start;
          if (endEl)   endEl.value   = prev.end;

          if (this.shifts[date]) {
            this.shifts[date].start = prev.start;
            this.shifts[date].end   = prev.end;
          }
        }
        appliedCount++;
      });

      showToast(`${appliedCount}日分を先週（${prevPeriod.label}）と同じ内容で入力しました`);

    } catch (err) {
      alert('先週のデータの取得に失敗しました。\n' + err.message);
      console.error('[Calendar] applySameAsLastWeek:', err);
    } finally {
      btn.disabled    = false;
      btn.textContent = '先週と同じ';
    }
  },

  // ============================================================
  // 確認画面への遷移
  // ============================================================

  /**
   * 「確認画面へ」ボタン
   * バリデーションを通過したら Confirmation を初期化して遷移
   */
  onGoToConfirm() {
    const { valid, shifts, errors } = this._validateAndCollect();

    if (!valid) {
      alert('⚠ 入力エラー\n\n' + errors.join('\n'));
      // 最初のエラーカードにスクロール
      const firstErrorDate = errors[0].split(':')[0];
      const firstCard = document.querySelector(`.date-card[data-date]`);
      if (firstCard) firstCard.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    // 期限超過チェック
    const today       = new Date(); today.setHours(0, 0, 0, 0);
    const deadline    = new Date(this.currentPeriod.deadline + 'T00:00:00');
    const isOverDeadline = today > deadline;

    Confirmation.init(this.currentPeriod, shifts, isOverDeadline);
    showScreen('confirmation');
  },

  // ============================================================
  // ユーティリティ
  // ============================================================

  /**
   * 全カードのデータを検証して収集
   * @returns {{ valid:boolean, shifts:Array, errors:Array<string> }}
   */
  _validateAndCollect() {
    const cards  = document.querySelectorAll('.date-card');
    const shifts = [];
    const errors = [];

    cards.forEach(card => {
      const date  = card.dataset.date;
      const shift = this.shifts[date];

      if (!shift || !shift.available) {
        // 勤務不可（または未入力）
        shifts.push({ date, available: false, start: null, end: null });
        return;
      }

      // 勤務可能の場合はバリデーション
      if (shift.start >= shift.end) {
        errors.push(`${this.formatDateLabel(date)}: 開始時刻は終了時刻より前にしてください`);
      }

      shifts.push({ date, available: true, start: shift.start, end: shift.end });
    });

    return { valid: errors.length === 0, shifts, errors };
  },

  /**
   * start〜end の全日付を YYYY-MM-DD 配列で返す
   * @param {string} start - YYYY-MM-DD
   * @param {string} end   - YYYY-MM-DD
   * @returns {string[]}
   */
  _getDatesInRange(start, end) {
    const dates   = [];
    const current = new Date(start + 'T00:00:00');
    const endDate = new Date(end   + 'T00:00:00');

    while (current <= endDate) {
      dates.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }

    return dates;
  },

  /**
   * "YYYY-MM-DD" を「5月16日（土）」形式に変換
   * @param {string} date - YYYY-MM-DD
   * @returns {string}
   */
  formatDateLabel(date) {
    const d        = new Date(date + 'T00:00:00');
    const month    = d.getMonth() + 1;
    const day      = d.getDate();
    const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
    return `${month}月${day}日（${weekdays[d.getDay()]}）`;
  },

  /**
   * 期限超過チェック。超過していれば警告バナーを表示
   * @param {string} deadline - YYYY-MM-DD
   */
  _checkDeadline(deadline) {
    const today      = new Date(); today.setHours(0, 0, 0, 0);
    const deadlineD  = new Date(deadline + 'T00:00:00');
    const warningEl  = document.getElementById('calendar-deadline-warning');

    if (!warningEl) return;

    if (today > deadlineD) {
      warningEl.textContent = `⚠ 提出期限（${this.formatDateLabel(deadline)}）を過ぎています`;
      warningEl.style.display = '';
    } else {
      warningEl.style.display = 'none';
    }
  }
};
