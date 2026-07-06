/**
 * アレグリア シフト管理ツール - カレンダー入力画面モジュール
 *
 * 期間内の各日付をカード形式で表示し、勤務可否とシフト種別（枠）を入力させる。
 *
 * 枠（slot）は店舗ごとに動的。呼び出し側が init() の第4引数に shift_slots
 * （is_active=true・sort_order昇順）を渡すと、その枠でボタンを生成する。
 * 渡さない場合はアレグリア従来の2枠（ランチ固定・ディナー編集可）で動作する
 * （GAS版 index.html など、shift_slots を持たない呼び出しは従来どおり）。
 *
 * 枠ごとの時刻編集可否:
 *   sort_order 最小の枠 = 時刻固定（現行ランチ相当）、それ以降 = 編集可（現行ディナー相当）。
 *
 * 内部データ構造:
 *   this.shifts[date] = {
 *     available : boolean,
 *     sel       : { [slot_key]: { on: boolean, start: "HH:MM", end: "HH:MM" } }
 *   }
 *
 * GAS/DB送信用データ（_computeStartEnd で変換）:
 *   { date, available, start: "HH:MM" | null, end: "HH:MM" | null }
 *   ※ 選択枠の最小start〜最大end に畳む（複数選択＝通し）。shift_type は
 *     保存側（api_v2 shiftTypeOf）が {start,end} から推論する既存規約のまま。
 */
const Calendar = {

  currentPeriod: null,
  shifts: {},
  viewOnly: false,
  backAction: null,

  // 枠が渡されなかったときの既定（アレグリア従来の2枠）。
  // 1枠目=固定・2枠目=編集可。default_start/end は "HH:MM"。
  DEFAULT_SLOTS: [
    { slot_key: 'lunch',  name: 'ランチ',   start: '10:30', end: '15:00', editable: false },
    { slot_key: 'dinner', name: 'ディナー', start: '17:00', end: '23:00', editable: true  }
  ],

  // init() で確定する実効枠リスト
  _activeSlots: null,

  // 予約語の表示名（全画面共通で参照できる定数）。
  // 現行の提出/閲覧画面は時刻レンジ表示のままなので直接は使わないが、
  // shift_type を名称表示したい箇所が今後出た場合の共通定義として置く。
  RESERVED_LABELS: { off: '休み', both: '通し' },

  // ============================================================
  // 初期化
  // ============================================================

  /**
   * カレンダー画面を初期化
   * @param {Object}  period         - 期間情報 {id, label, start, end, deadline, storeId}
   * @param {Array}   existingShifts - 提出済みシフト（再編集/閲覧時のみ）。{date, available, start, end}
   * @param {boolean} viewOnly       - true=閲覧専用モード（過去期間の確認用）
   * @param {Array}   slots          - shift_slots 行（is_active=true, sort_order昇順）。
   *                                    未指定なら DEFAULT_SLOTS（従来2枠）。
   */
  init(period, existingShifts, viewOnly, slots) {
    existingShifts = existingShifts || [];
    viewOnly = viewOnly || false;

    this.currentPeriod = period;
    this.viewOnly = viewOnly;
    this._activeSlots = (slots && slots.length) ? this._normalizeSlots(slots) : this.DEFAULT_SLOTS;
    this.shifts = {};

    // 提出済みシフトを {start,end} → 内部モデル（枠選択）へ変換
    existingShifts.forEach(function(s) {
      if (!s.available) {
        var blank = this._blankShift();
        blank.available = false;
        this.shifts[s.date] = blank;
      } else {
        this.shifts[s.date] = { available: true, sel: this._inferSelection(s.start, s.end) };
      }
    }, this);

    document.getElementById('calendar-title').textContent =
      viewOnly ? '提出済みシフト' : 'シフトを入力してください';
    document.getElementById('calendar-period-label').textContent = period.label;
    if (viewOnly) {
      document.getElementById('calendar-deadline-warning').style.display = 'none';
    } else {
      this._checkDeadline(period.deadline);
    }
    this._renderCalendar(period);

    var confirmBtn = document.getElementById('btn-go-to-confirm');
    var viewBadge  = document.getElementById('calendar-view-only-badge');
    var toolbar    = document.getElementById('calendar-toolbar');
    if (confirmBtn) confirmBtn.style.display = viewOnly ? 'none' : '';
    if (viewBadge)  viewBadge.style.display  = viewOnly ? ''     : 'none';
    if (toolbar)    toolbar.style.display    = viewOnly ? 'none' : '';
  },

  /**
   * shift_slots 行 → 内部枠モデルへ正規化。
   * sort_order 昇順に並べ、先頭（最小）を固定・以降を編集可とする。
   */
  _normalizeSlots(rows) {
    var sorted = rows.slice().sort(function(a, b) {
      return (a.sort_order || 0) - (b.sort_order || 0);
    });
    return sorted.map(function(r, i) {
      return {
        slot_key: r.slot_key,
        name    : r.name,
        start   : String(r.default_start).slice(0, 5),
        end     : String(r.default_end).slice(0, 5),
        editable: i > 0
      };
    });
  },

  _slotByKey(key) {
    return (this._activeSlots || []).filter(function(s) { return s.slot_key === key; })[0] || null;
  },

  /** 全枠オフ・available:false の空シフトを作る（枠ごとの初期時刻は既定値） */
  _blankShift() {
    var sel = {};
    this._activeSlots.forEach(function(s) {
      sel[s.slot_key] = { on: false, start: s.start, end: s.end };
    });
    return { available: false, sel: sel };
  },

  _shiftTypeNames() {
    return this._activeSlots.map(function(s) { return s.name; });
  },

  /** 「シフト種別（ランチ/ディナー…）を選んでください」文言（枠名から動的生成） */
  _shiftTypePrompt() {
    return 'シフト種別（' + this._shiftTypeNames().join('/') + '）を選んでください';
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
    var shift    = this.shifts[date] || this._blankShift();
    var isAvail  = shift.available;
    var dayLabel = this.formatDateLabel(date);
    var disabled = this.viewOnly ? ' disabled' : '';
    var self     = this;

    // 枠トグルボタン群
    var buttonsHtml = this._activeSlots.map(function(slot) {
      var cell = shift.sel[slot.slot_key] || { on: false, start: slot.start, end: slot.end };
      var hint = slot.editable
        ? '<span class="shift-time-hint" id="' + slot.slot_key + '-hint-' + date + '">' +
            cell.start + '〜' + cell.end + '</span>'
        : '<span class="shift-time-hint">' + slot.start + '〜' + slot.end + '</span>';
      return '<button class="shift-type-btn ' + (cell.on ? 'active' : '') + '" ' +
        'id="' + slot.slot_key + '-btn-' + date + '" ' +
        'onclick="Calendar.onShiftTypeToggle(\'' + date + '\', \'' + slot.slot_key + '\')"' + disabled + '>' +
        self._esc(slot.name) + hint +
      '</button>';
    }).join('');

    // 編集可枠の詳細設定（開始/終了）アコーディオン
    var detailsHtml = this._activeSlots.filter(function(slot) {
      return slot.editable;
    }).map(function(slot) {
      var cell      = shift.sel[slot.slot_key] || { on: false, start: slot.start, end: slot.end };
      var startOpts = self._buildSelectOptions(self._slotStartOptions(slot), cell.start);
      var endOpts   = self._buildSelectOptions(self._slotEndOptions(slot),   cell.end);
      return '<div class="dinner-detail" id="' + slot.slot_key + '-detail-' + date + '" ' +
          (cell.on ? '' : 'style="display:none"') + '>' +
        '<button class="dinner-detail-toggle" ' +
          'onclick="Calendar.toggleSlotDetail(\'' + date + '\', \'' + slot.slot_key + '\')"' + disabled + '>▼ 詳細設定</button>' +
        '<div class="dinner-detail-body" id="' + slot.slot_key + '-detail-body-' + date + '" style="display:none">' +
          '<div class="time-row">' +
            '<label class="time-label" for="' + slot.slot_key + '-start-' + date + '">開始</label>' +
            '<select class="time-select" id="' + slot.slot_key + '-start-' + date + '" ' +
              'onchange="Calendar.onSlotDetailChange(\'' + date + '\', \'' + slot.slot_key + '\')"' + disabled + '>' +
              startOpts +
            '</select>' +
          '</div>' +
          '<div class="time-row">' +
            '<label class="time-label" for="' + slot.slot_key + '-end-' + date + '">終了</label>' +
            '<select class="time-select" id="' + slot.slot_key + '-end-' + date + '" ' +
              'onchange="Calendar.onSlotDetailChange(\'' + date + '\', \'' + slot.slot_key + '\')"' + disabled + '>' +
              endOpts +
            '</select>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<div class="date-card' + (this.viewOnly ? ' view-only' : '') + '" data-date="' + date + '">' +

      '<div class="date-card-header">' +
        '<span class="date-label">' + dayLabel + '</span>' +
      '</div>' +

      // 勤務可否トグル（大きい長方形・2択）
      '<div class="availability-toggle" role="group" aria-label="勤務可否">' +
        '<button class="toggle-btn ' + (isAvail ? 'active available' : '') + '" ' +
          'onclick="Calendar.onToggle(\'' + date + '\', true)" ' +
          'aria-pressed="' + isAvail + '"' + disabled + '>勤務可能</button>' +
        '<button class="toggle-btn ' + (!isAvail ? 'active unavailable' : '') + '" ' +
          'onclick="Calendar.onToggle(\'' + date + '\', false)" ' +
          'aria-pressed="' + !isAvail + '"' + disabled + '>勤務不可</button>' +
      '</div>' +

      // シフト種別セクション（勤務可能時のみ表示）
      '<div class="shift-type-section" id="shift-type-' + date + '" ' +
          (isAvail ? '' : 'style="display:none"') + '>' +
        '<p class="shift-type-label">シフト種別</p>' +
        '<div class="shift-type-buttons">' +
          buttonsHtml +
        '</div>' +

        detailsHtml +

        '<p class="shift-type-error" id="shift-type-error-' + date + '" style="display:none">' +
          '⚠ ' + this._shiftTypePrompt() +
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

  /** 枠名など店舗設定テキストのHTMLエスケープ（他ファイル依存を避けるため自前で持つ） */
  _esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  /**
   * 編集可枠の開始時刻オプション。default_start の1時間前 〜 default_end の30分前（30分刻み）。
   * 従来ディナー（17:00〜23:00）では 16:00〜22:30 となり従来と一致。
   */
  _slotStartOptions(slot) {
    return this._timeOpts(this._toMin(slot.start) - 60, this._toMin(slot.end) - 30);
  },

  /**
   * 編集可枠の終了時刻オプション。default_start の30分前 〜 default_end（30分刻み）。
   * 従来ディナー（17:00〜23:00）では 16:30〜23:00 となり従来と一致。
   */
  _slotEndOptions(slot) {
    return this._timeOpts(this._toMin(slot.start) - 30, this._toMin(slot.end));
  },

  _timeOpts(fromMin, toMin) {
    var opts = [];
    for (var m = Math.max(0, fromMin); m <= toMin; m += 30) {
      opts.push(this._fromMin(m));
    }
    return opts;
  },

  _toMin(hhmm) {
    var p = String(hhmm).split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  },

  _fromMin(min) {
    var h = Math.floor(min / 60);
    var m = min % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
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
    if (this.viewOnly) return;
    if (!this.shifts[date]) this.shifts[date] = this._blankShift();
    this.shifts[date].available = available;

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
   * 枠ボタンが押されたとき（オン/オフ切り替え）
   * @param {string} date    - YYYY-MM-DD
   * @param {string} slotKey - shift_slots.slot_key
   */
  onShiftTypeToggle(date, slotKey) {
    if (this.viewOnly) return;
    if (!this.shifts[date]) {
      this.shifts[date] = this._blankShift();
      this.shifts[date].available = true;
    }
    var cell = this.shifts[date].sel[slotKey];
    if (!cell) return;

    cell.on = !cell.on;

    var btn = document.getElementById(slotKey + '-btn-' + date);
    if (btn) btn.classList.toggle('active', cell.on);

    // 編集可枠のオン/オフで詳細設定セクションを表示切り替え
    var slot = this._slotByKey(slotKey);
    if (slot && slot.editable) {
      var detail = document.getElementById(slotKey + '-detail-' + date);
      if (detail) detail.style.display = cell.on ? '' : 'none';
    }

    // インラインエラーをリセット
    var errEl = document.getElementById('shift-type-error-' + date);
    if (errEl) errEl.style.display = 'none';
  },

  /**
   * 「▼ 詳細設定」アコーディオンのトグル
   * @param {string} date    - YYYY-MM-DD
   * @param {string} slotKey - shift_slots.slot_key
   */
  toggleSlotDetail(date, slotKey) {
    if (this.viewOnly) return;
    var body = document.getElementById(slotKey + '-detail-body-' + date);
    if (!body) return;
    var isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : '';
    var toggleBtn = body.previousElementSibling;
    if (toggleBtn) toggleBtn.textContent = (isOpen ? '▼' : '▲') + ' 詳細設定';
  },

  /**
   * 編集可枠の詳細設定の時刻が変わったとき
   * データを更新し、枠ボタン内のヒント表示も更新する
   * @param {string} date    - YYYY-MM-DD
   * @param {string} slotKey - shift_slots.slot_key
   */
  onSlotDetailChange(date, slotKey) {
    if (this.viewOnly) return;
    var startEl = document.getElementById(slotKey + '-start-' + date);
    var endEl   = document.getElementById(slotKey + '-end-'   + date);
    if (!startEl || !endEl) return;

    var cell = this.shifts[date] && this.shifts[date].sel[slotKey];
    if (cell) {
      cell.start = startEl.value;
      cell.end   = endEl.value;
    }

    var hint = document.getElementById(slotKey + '-hint-' + date);
    if (hint) hint.textContent = startEl.value + '〜' + endEl.value;
  },

  // ============================================================
  // ショートカット
  // ============================================================

  setAllUnavailable() {
    if (this.viewOnly) return;
    document.querySelectorAll('.date-card').forEach(function(card) {
      this.onToggle(card.dataset.date, false);
    }, this);
    showToast('すべての日を勤務不可に設定しました');
  },

  // ============================================================
  // 確認画面への遷移
  // ============================================================

  onGoToConfirm() {
    if (this.viewOnly) return;
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

      // 勤務可能だが枠が未選択
      var anyOn = self._activeSlots.some(function(s) {
        return shift.sel[s.slot_key] && shift.sel[s.slot_key].on;
      });
      if (!anyOn) {
        errors.push(self.formatDateLabel(date) + ': ' + self._shiftTypePrompt());
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
   * 内部モデル → 送信用 {start, end} に変換。
   * 選択枠の最小start〜最大end に畳む（複数選択＝通し）。
   * 従来2枠での結果:
   *   ランチのみ     : 10:30〜15:00
   *   ディナーのみ   : dinnerStart〜dinnerEnd
   *   ランチ+ディナー: 10:30〜dinnerEnd（＝従来と一致）
   */
  _computeStartEnd(shift) {
    var starts = [];
    var ends   = [];
    this._activeSlots.forEach(function(s) {
      var cell = shift.sel[s.slot_key];
      if (cell && cell.on) {
        starts.push(cell.start);
        ends.push(cell.end);
      }
    });
    // "HH:MM" は辞書順＝時刻順
    starts.sort();
    ends.sort();
    return { start: starts[0], end: ends[ends.length - 1] };
  },

  /**
   * 送信形式 {start, end} から枠の選択状態を復元（閲覧/再編集用）。
   * 従来 _inferShiftType と同じ判定を一般化:
   *   start=先頭枠start, end=先頭枠end        → 先頭枠のみ
   *   start=先頭枠start, end≠先頭枠end         → 先頭枠 + 最終編集枠（end を復元）
   *   start≠先頭枠start                        → 最終編集枠のみ（start/end を復元）
   * ※ 3枠以上の「通し」復元は一意に定まらないため上記のベストエフォート。
   *   保存値（{start,end}）自体は保持され、時刻レンジ表示には影響しない。
   */
  _inferSelection(start, end) {
    var slots = this._activeSlots;
    var sel = {};
    slots.forEach(function(s) { sel[s.slot_key] = { on: false, start: s.start, end: s.end }; });
    if (!slots.length) return sel;

    var first = slots[0];

    // 最終の編集可枠（無ければ最終枠）
    var lastEditable = null;
    for (var i = slots.length - 1; i >= 0; i--) {
      if (slots[i].editable) { lastEditable = slots[i]; break; }
    }
    if (!lastEditable) lastEditable = slots[slots.length - 1];

    if (start === first.start) {
      sel[first.slot_key].on = true;
      if (end === first.end) {
        return sel; // 先頭枠のみ
      }
      // 先頭枠 + 最終編集枠（end を復元、開始は既定のまま）
      sel[lastEditable.slot_key].on  = true;
      sel[lastEditable.slot_key].end = end;
      return sel;
    }

    // 先頭枠の開始と違う → 最終編集枠のみ（start/end を復元）
    sel[lastEditable.slot_key].on    = true;
    sel[lastEditable.slot_key].start = start;
    sel[lastEditable.slot_key].end   = end;
    return sel;
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

  onBack() {
    if (typeof this.backAction === 'function') {
      this.backAction();
      return;
    }
    showScreen('period-selector');
    PeriodSelector.init();
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
