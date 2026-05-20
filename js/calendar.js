/**
 * アレグリア シフト管理ツール - カレンダー入力画面モジュール
 *
 * 期間内の各日付をカード形式で表示し、勤務可否とシフト種別（ランチ/ディナー）を入力させる。
 *
 * 内部データ構造:
 *   this.shifts[date] = {
 *     available : boolean,
 *     lunch     : boolean,
 *     dinner    : boolean,
 *     dinnerStart: "HH:MM",
 *     dinnerEnd  : "HH:MM"
 *   }
 *
 * GAS送信用データ（_computeStartEnd で変換）:
 *   { date, available, start: "HH:MM" | null, end: "HH:MM" | null }
 */
const Calendar = {

  currentPeriod: null,
  shifts: {},

  // ランチ固定時間
  LUNCH_START: '10:30',
  LUNCH_END  : '15:00',

  // ディナーデフォルト時間
  DINNER_DEFAULT_START: '17:00',
  DINNER_DEFAULT_END  : '23:00',

  // ディナー開始時間オプション: 16:00〜22:30, 30分刻み
  DINNER_START_OPTIONS: (() => {
    const opts = [];
    for (let h = 16; h <= 22; h++) {
      opts.push(String(h).padStart(2, '0') + ':00');
      opts.push(String(h).padStart(2, '0') + ':30');
    }
    return opts;
  })(),

  // ディナー終了時間オプション: 16:30〜23:00, 30分刻み
  DINNER_END_OPTIONS: (() => {
    const opts = [];
    for (let h = 16; h <= 23; h++) {
      if (h > 16) opts.push(String(h).padStart(2, '0') + ':00');
      if (h < 23) opts.push(String(h).padStart(2, '0') + ':30');
    }
    return opts;
  })(),

  // ============================================================
  // 初期化
  // ============================================================

  /**
   * カレンダー画面を初期化
   * @param {Object}  period         - 期間情報 {id, label, start, end, deadline}
   * @param {Array}   existingShifts - 提出済みシフト（再編集時のみ渡す）。GAS形式 {date, available, start, end}
   * @param {boolean} viewOnly       - true=閲覧専用モード（過去期間の確認用）
   */
  init(period, existingShifts, viewOnly) {
    existingShifts = existingShifts || [];
    viewOnly = viewOnly || false;

    this.currentPeriod = period;
    this.shifts = {};

    // 提出済みシフトをGAS形式 → 内部モデルへ変換
    existingShifts.forEach(function(s) {
      if (!s.available) {
        this.shifts[s.date] = {
          available  : false,
          lunch      : false,
          dinner     : false,
          dinnerStart: this.DINNER_DEFAULT_START,
          dinnerEnd  : this.DINNER_DEFAULT_END
        };
      } else {
        var inferred = this._inferShiftType(s.start, s.end);
        this.shifts[s.date] = {
          available  : true,
          lunch      : inferred.lunch,
          dinner     : inferred.dinner,
          dinnerStart: inferred.dinnerStart,
          dinnerEnd  : inferred.dinnerEnd
        };
      }
    }, this);

    document.getElementById('calendar-period-label').textContent = period.label;
    this._checkDeadline(period.deadline);
    this._renderCalendar(period);

    var confirmBtn = document.getElementById('btn-go-to-confirm');
    var viewBadge  = document.getElementById('calendar-view-only-badge');
    if (confirmBtn) confirmBtn.style.display = viewOnly ? 'none' : '';
    if (viewBadge)  viewBadge.style.display  = viewOnly ? ''     : 'none';
  },

  // ============================================================
  // 描画
  // ============================================================

  _renderCalendar(period) {
    var container = document.getElementById('calendar-cards-container');
    var dates     = this._getDatesInRange(period.start, period.end);
    container.innerHTML = dates.map(function(date) {
      return this._createCardHtml(date);
    }, this).join('');
  },

  /**
   * 1日分のカードHTMLを生成
   * @param {string} date - YYYY-MM-DD
   */
  _createCardHtml(date) {
    var shift = this.shifts[date] || {
      available  : false,
      lunch      : false,
      dinner     : false,
      dinnerStart: this.DINNER_DEFAULT_START,
      dinnerEnd  : this.DINNER_DEFAULT_END
    };
    var isAvail    = shift.available;
    var dayLabel   = this.formatDateLabel(date);
    var dinnerHint = shift.dinnerStart + '〜' + shift.dinnerEnd;

    var dinnerStartOpts = this._buildSelectOptions(this.DINNER_START_OPTIONS, shift.dinnerStart);
    var dinnerEndOpts   = this._buildSelectOptions(this.DINNER_END_OPTIONS,   shift.dinnerEnd);

    return '<div class="date-card" data-date="' + date + '">' +

      '<div class="date-card-header">' +
        '<span class="date-label">' + dayLabel + '</span>' +
      '</div>' +

      // 勤務可否トグル（大きい長方形・2択）
      '<div class="availability-toggle" role="group" aria-label="勤務可否">' +
        '<button class="toggle-btn ' + (isAvail ? 'active available' : '') + '" ' +
          'onclick="Calendar.onToggle(\'' + date + '\', true)" ' +
          'aria-pressed="' + isAvail + '">勤務可能</button>' +
        '<button class="toggle-btn ' + (!isAvail ? 'active unavailable' : '') + '" ' +
          'onclick="Calendar.onToggle(\'' + date + '\', false)" ' +
          'aria-pressed="' + !isAvail + '">勤務不可</button>' +
      '</div>' +

      // シフト種別セクション（勤務可能時のみ表示）
      '<div class="shift-type-section" id="shift-type-' + date + '" ' +
          (isAvail ? '' : 'style="display:none"') + '>' +
        '<p class="shift-type-label">シフト種別</p>' +
        '<div class="shift-type-buttons">' +
          '<button class="shift-type-btn ' + (shift.lunch ? 'active' : '') + '" ' +
            'id="lunch-btn-' + date + '" ' +
            'onclick="Calendar.onShiftTypeToggle(\'' + date + '\', \'lunch\')">' +
            'ランチ' +
            '<span class="shift-time-hint">10:30〜15:00</span>' +
          '</button>' +
          '<button class="shift-type-btn ' + (shift.dinner ? 'active' : '') + '" ' +
            'id="dinner-btn-' + date + '" ' +
            'onclick="Calendar.onShiftTypeToggle(\'' + date + '\', \'dinner\')">' +
            'ディナー' +
            '<span class="shift-time-hint" id="dinner-hint-' + date + '">' + dinnerHint + '</span>' +
          '</button>' +
        '</div>' +

        // ディナー詳細設定アコーディオン（ディナー選択時のみ表示）
        '<div class="dinner-detail" id="dinner-detail-' + date + '" ' +
            (shift.dinner ? '' : 'style="display:none"') + '>' +
          '<button class="dinner-detail-toggle" ' +
            'onclick="Calendar.toggleDinnerDetail(\'' + date + '\')">▼ 詳細設定</button>' +
          '<div class="dinner-detail-body" id="dinner-detail-body-' + date + '" style="display:none">' +
            '<div class="time-row">' +
              '<label class="time-label" for="dinner-start-' + date + '">開始</label>' +
              '<select class="time-select" id="dinner-start-' + date + '" ' +
                'onchange="Calendar.onDinnerDetailChange(\'' + date + '\')">' +
                dinnerStartOpts +
              '</select>' +
            '</div>' +
            '<div class="time-row">' +
              '<label class="time-label" for="dinner-end-' + date + '">終了</label>' +
              '<select class="time-select" id="dinner-end-' + date + '" ' +
                'onchange="Calendar.onDinnerDetailChange(\'' + date + '\')">' +
                dinnerEndOpts +
              '</select>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<p class="shift-type-error" id="shift-type-error-' + date + '" style="display:none">' +
          '⚠ シフト種別（ランチ/ディナー）を選んでください' +
        '</p>' +
      '</div>' +

    '</div>';
  },

  /**
   * select要素の <option> 群を生成
   * @param {string[]} options      - 選択肢リスト "HH:MM"[]
   * @param {string}   selectedTime - 現在の選択値
   */
  _buildSelectOptions(options, selectedTime) {
    return options.map(function(t) {
      return '<option value="' + t + '"' + (t === selectedTime ? ' selected' : '') + '>' + t + '</option>';
    }).join('');
  },

  // ============================================================
  // イベントハンドラ
  // ============================================================

  /**
   * 勤務可否トグルが押されたとき
   * @param {string}  date      - YYYY-MM-DD
   * @param {boolean} available
   */
  onToggle(date, available) {
    if (!this.shifts[date]) {
      this.shifts[date] = {
        available  : available,
        lunch      : false,
        dinner     : false,
        dinnerStart: this.DINNER_DEFAULT_START,
        dinnerEnd  : this.DINNER_DEFAULT_END
      };
    } else {
      this.shifts[date].available = available;
    }

    var card = document.querySelector('.date-card[data-date="' + date + '"]');
    if (!card) return;

    // トグルボタンのスタイル更新
    card.querySelectorAll('.toggle-btn').forEach(function(btn) {
      btn.classList.remove('active', 'available', 'unavailable');
      btn.removeAttribute('aria-pressed');
    });
    var activeBtn = card.querySelector('.toggle-btn:nth-child(' + (available ? 1 : 2) + ')');
    if (activeBtn) {
      activeBtn.classList.add('active', available ? 'available' : 'unavailable');
      activeBtn.setAttribute('aria-pressed', 'true');
    }

    // シフト種別セクションの表示/非表示
    var shiftTypeSection = document.getElementById('shift-type-' + date);
    if (shiftTypeSection) shiftTypeSection.style.display = available ? '' : 'none';

    // 勤務不可にしたらインラインエラーをリセット
    if (!available) {
      var errEl = document.getElementById('shift-type-error-' + date);
      if (errEl) errEl.style.display = 'none';
    }
  },

  /**
   * ランチ/ディナーボタンが押されたとき（オン/オフ切り替え）
   * @param {string} date - YYYY-MM-DD
   * @param {string} type - 'lunch' | 'dinner'
   */
  onShiftTypeToggle(date, type) {
    if (!this.shifts[date]) {
      this.shifts[date] = {
        available  : true,
        lunch      : false,
        dinner     : false,
        dinnerStart: this.DINNER_DEFAULT_START,
        dinnerEnd  : this.DINNER_DEFAULT_END
      };
    }

    this.shifts[date][type] = !this.shifts[date][type];

    var btn = document.getElementById(type + '-btn-' + date);
    if (btn) btn.classList.toggle('active', this.shifts[date][type]);

    // ディナーのオン/オフで詳細設定セクションを表示切り替え
    if (type === 'dinner') {
      var detail = document.getElementById('dinner-detail-' + date);
      if (detail) detail.style.display = this.shifts[date].dinner ? '' : 'none';
    }

    // インラインエラーをリセット
    var errEl = document.getElementById('shift-type-error-' + date);
    if (errEl) errEl.style.display = 'none';
  },

  /**
   * 「▼ 詳細設定」アコーディオンのトグル
   * @param {string} date - YYYY-MM-DD
   */
  toggleDinnerDetail(date) {
    var body = document.getElementById('dinner-detail-body-' + date);
    if (!body) return;
    var isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : '';
    var toggleBtn = body.previousElementSibling;
    if (toggleBtn) toggleBtn.textContent = (isOpen ? '▼' : '▲') + ' 詳細設定';
  },

  /**
   * ディナー詳細設定の時刻が変わったとき
   * データを更新し、ディナーボタン内のヒント表示も更新する
   * @param {string} date - YYYY-MM-DD
   */
  onDinnerDetailChange(date) {
    var startEl = document.getElementById('dinner-start-' + date);
    var endEl   = document.getElementById('dinner-end-'   + date);
    if (!startEl || !endEl) return;

    var dinnerStart = startEl.value;
    var dinnerEnd   = endEl.value;

    if (this.shifts[date]) {
      this.shifts[date].dinnerStart = dinnerStart;
      this.shifts[date].dinnerEnd   = dinnerEnd;
    }

    var hint = document.getElementById('dinner-hint-' + date);
    if (hint) hint.textContent = dinnerStart + '〜' + dinnerEnd;
  },

  // ============================================================
  // ショートカット
  // ============================================================

  setAllUnavailable() {
    document.querySelectorAll('.date-card').forEach(function(card) {
      this.onToggle(card.dataset.date, false);
    }, this);
    showToast('すべての日を勤務不可に設定しました');
  },

  // ============================================================
  // 確認画面への遷移
  // ============================================================

  onGoToConfirm() {
    var result = this._validateAndCollect();

    if (!result.valid) {
      alert('⚠ 入力エラー\n\n' + result.errors.join('\n'));
      var firstCard = document.querySelector('.date-card[data-date]');
      if (firstCard) firstCard.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    var today    = new Date(); today.setHours(0, 0, 0, 0);
    var deadline = new Date(this.currentPeriod.deadline + 'T00:00:00');
    var isOverDeadline = today > deadline;

    Confirmation.init(this.currentPeriod, result.shifts, isOverDeadline);
    showScreen('confirmation');
  },

  // ============================================================
  // バリデーション & データ収集
  // ============================================================

  /**
   * 全カードのデータを検証して収集
   * @returns {{ valid:boolean, shifts:Array, errors:Array<string> }}
   */
  _validateAndCollect() {
    var cards  = document.querySelectorAll('.date-card');
    var shifts = [];
    var errors = [];
    var self   = this;

    cards.forEach(function(card) {
      var date  = card.dataset.date;
      var shift = self.shifts[date];

      // 未入力 or 勤務不可
      if (!shift || !shift.available) {
        shifts.push({ date: date, available: false, start: null, end: null });
        return;
      }

      // 勤務可能だがシフト種別が未選択
      if (!shift.lunch && !shift.dinner) {
        errors.push(self.formatDateLabel(date) + ': シフト種別（ランチ/ディナー）を選んでください');
        var errEl = document.getElementById('shift-type-error-' + date);
        if (errEl) errEl.style.display = '';
        shifts.push({ date: date, available: false, start: null, end: null });
        return;
      }

      var computed = self._computeStartEnd(shift);
      shifts.push({ date: date, available: true, start: computed.start, end: computed.end });
    });

    return { valid: errors.length === 0, shifts: shifts, errors: errors };
  },

  /**
   * 内部モデル → GAS送信用 {start, end} に変換
   * - ランチのみ     : start=10:30, end=15:00
   * - ディナーのみ   : start=dinnerStart, end=dinnerEnd
   * - ランチ+ディナー: start=10:30, end=dinnerEnd（ディナー開始は無視）
   */
  _computeStartEnd(shift) {
    if (shift.lunch && !shift.dinner) {
      return { start: this.LUNCH_START, end: this.LUNCH_END };
    }
    if (!shift.lunch && shift.dinner) {
      return { start: shift.dinnerStart, end: shift.dinnerEnd };
    }
    // ランチ + ディナー
    return { start: this.LUNCH_START, end: shift.dinnerEnd };
  },

  /**
   * GAS形式 {start, end} から内部モデルのランチ/ディナー状態を推定
   *
   * 推定ルール:
   *   start=10:30, end=15:00         → ランチのみ
   *   start=10:30, end>=17:00        → ランチ+ディナー
   *   start=10:30 以外               → ディナーのみ（詳細設定で復元）
   */
  _inferShiftType(start, end) {
    if (start === this.LUNCH_START && end === this.LUNCH_END) {
      return {
        lunch      : true,
        dinner     : false,
        dinnerStart: this.DINNER_DEFAULT_START,
        dinnerEnd  : this.DINNER_DEFAULT_END
      };
    }
    if (start === this.LUNCH_START) {
      // ランチ + ディナー（end がディナー終了時刻）
      return {
        lunch      : true,
        dinner     : true,
        dinnerStart: this.DINNER_DEFAULT_START,
        dinnerEnd  : end || this.DINNER_DEFAULT_END
      };
    }
    // ディナーのみ（start/end を詳細設定値として復元）
    return {
      lunch      : false,
      dinner     : true,
      dinnerStart: start || this.DINNER_DEFAULT_START,
      dinnerEnd  : end   || this.DINNER_DEFAULT_END
    };
  },

  // ============================================================
  // ユーティリティ
  // ============================================================

  _getDatesInRange(start, end) {
    var dates   = [];
    var current = new Date(start + 'T00:00:00');
    var endDate = new Date(end   + 'T00:00:00');

    while (current <= endDate) {
      dates.push(this._formatLocalDate(current));
      current.setDate(current.getDate() + 1);
    }

    return dates;
  },

  _formatLocalDate(date) {
    var year  = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, '0');
    var day   = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  },

  formatDateLabel(date) {
    var d        = new Date(date + 'T00:00:00');
    var month    = d.getMonth() + 1;
    var day      = d.getDate();
    var weekdays = ['日', '月', '火', '水', '木', '金', '土'];
    return month + '月' + day + '日（' + weekdays[d.getDay()] + '）';
  },

  _checkDeadline(deadline) {
    var today      = new Date(); today.setHours(0, 0, 0, 0);
    var deadlineD  = new Date(deadline + 'T00:00:00');
    var warningEl  = document.getElementById('calendar-deadline-warning');
    if (!warningEl) return;

    if (today > deadlineD) {
      warningEl.textContent   = '⚠ 提出期限（' + this.formatDateLabel(deadline) + '）を過ぎています';
      warningEl.style.display = '';
    } else {
      warningEl.style.display = 'none';
    }
  }
};
