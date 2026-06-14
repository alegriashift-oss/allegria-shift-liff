/**
 * アレグリア シフト管理ツール - 店長ツール（admin-v2.html 専用）
 *
 * 提出された希望を見ながら、日ごとにスタッフへシフトを割り当て（たたき台）、
 * 確定（公開）するとスタッフのアプリに表示される。
 *
 * データの流れ:
 *   submissions / submission_items（スタッフの希望・読み取りのみ）
 *   → published_shifts（たたき台 status='draft' → 確定 status='published'）
 *
 * 権限はRLSが担保（店長以外はpublished_shiftsの編集も希望の閲覧もできない）。
 * ロード順: config_v2.js → api_v2.js → admin_v2.js
 */

const AdminState = {
  userId     : null,
  displayName: null,
  managed    : []   // 店長権限を持つ所属 [{store_id, store_name, role, ...}]
};

// ============================================================
// 汎用ユーティリティ（このページ専用。submit-v2側とは独立）
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

/** DBの期間行 → このページで使うVM */
function adminPeriodVM(p) {
  const membership = AdminState.managed.find(m => m.store_id === p.store_id);
  const storeName  = membership ? membership.store_name : '';
  const multiStore = AdminState.managed.length > 1;
  return {
    id      : p.id,
    storeId : p.store_id,
    label   : (multiStore && storeName ? storeName + ' / ' : '') + p.title,
    start   : String(p.start_date).slice(0, 10),
    end     : String(p.end_date).slice(0, 10),
    status  : p.status
  };
}

// ============================================================
// 期間選択画面
// ============================================================

const AdminPeriods = {
  _periods: [],

  async init() {
    showScreen('period-list');
    const container = document.getElementById('admin-period-list');
    container.innerHTML = '<p class="loading-text">期間を読み込み中…</p>';
    try {
      const rows = await SupaAPI.getManagePeriods(AdminState.managed.map(m => m.store_id));
      this._periods = rows.map(adminPeriodVM);
      if (!this._periods.length) {
        container.innerHTML = '<p class="info-text">表示できる期間はありません。</p>';
        return;
      }
      container.innerHTML = this._periods.map((p, index) => `
        <button class="history-period-btn" onclick="AdminPeriods.open(${index})">
          <span>${escapeHtml(p.label)}<span class="period-status-badge ${p.status === 'open' ? 'open' : 'closed'}">${p.status === 'open' ? '提出受付中' : '締切済み'}</span></span>
          <span class="history-arrow">›</span>
        </button>
      `).join('');
    } catch (err) {
      container.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  },

  open(index) {
    const period = this._periods[index];
    if (period) DraftEditor.init(period);
  }
};

// ============================================================
// メンバー管理画面（期間に紐づかない・店舗単位の機能）
// ============================================================

const MemberManager = {
  _storeId    : null,   // 選択中の店舗
  _members    : [],     // active＋retired の全行（サーバーの並び順）
  _showRetired: false,
  _sortable   : null,   // SortableJSのインスタンス（コンテナに一度だけ付ける）
  _addEmp     : 'part_time', // 追加フォームで選択中の雇用区分
  _editId     : null,   // 編集中のメンバーID
  _editEmp    : 'part_time', // 編集モーダルで選択中の雇用区分
  _editRole   : 'staff',     // 編集モーダルで選択中の役割
  _editOrigRole: 'staff',    // 編集を開いた時点の役割（変更検知用）

  /** 期間選択画面の「メンバー管理」ボタンから入る */
  open() {
    if (!this._storeId ||
        !AdminState.managed.some(m => m.store_id === this._storeId)) {
      this._storeId = AdminState.managed.length
        ? AdminState.managed[0].store_id : null;
    }
    if (!this._storeId) {
      showToast('店長権限のある店舗がありません');
      return;
    }
    showScreen('member-list');
    this.hideAddForm();
    const toggle = document.getElementById('member-show-retired');
    if (toggle) toggle.checked = this._showRetired;
    this._renderStoreTabs();
    this.load();
  },

  _store() {
    return AdminState.managed.find(m => m.store_id === this._storeId) || null;
  },

  /** 選択中の店舗における自分の役割（'admin' / 'manager'）。= currentUserRole */
  _currentRole() {
    const me = AdminState.managed.find(m => m.store_id === this._storeId);
    return me ? me.role : 'staff';
  },

  _active()  { return this._members.filter(m => m.status === 'active'); },
  _retired() { return this._members.filter(m => m.status === 'retired'); },

  // --------------------------------------------------------
  // 店舗切り替え
  // --------------------------------------------------------

  _renderStoreTabs() {
    const label = document.getElementById('member-store-label');
    const store = this._store();
    if (label) label.textContent = store ? store.store_name : '';

    const tabs = document.getElementById('member-store-tabs');
    if (!tabs) return;
    if (AdminState.managed.length < 2) {
      tabs.style.display = 'none';
      return;
    }
    tabs.style.display = '';
    tabs.innerHTML = AdminState.managed.map(m => `
      <button class="store-tab${m.store_id === this._storeId ? ' on' : ''}"
        onclick="MemberManager.switchStore('${m.store_id}')">${escapeHtml(m.store_name)}</button>
    `).join('');
  },

  switchStore(storeId) {
    if (!AdminState.managed.some(m => m.store_id === storeId)) return;
    this._storeId = storeId;
    this.hideAddForm();
    this._renderStoreTabs();
    this.load();
  },

  // --------------------------------------------------------
  // 読み込みと描画
  // --------------------------------------------------------

  async load() {
    const activeBox = document.getElementById('member-list-active');
    const retiredBox = document.getElementById('member-list-retired');
    activeBox.innerHTML = '<p class="loading-text">メンバーを読み込み中…</p>';
    retiredBox.innerHTML = '';
    try {
      this._members = await SupaAPI.getStoreMembers(this._storeId);
      this.renderList();
    } catch (err) {
      activeBox.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    }
  },

  renderList() {
    const activeBox = document.getElementById('member-list-active');
    const active = this._active();
    activeBox.innerHTML = active.length
      ? active.map(m => this._rowHtml(m)).join('')
      : '<p class="info-text">メンバーがいません。「＋ メンバーを追加」から登録できます。</p>';
    this._initSortable();

    const retiredBox = document.getElementById('member-list-retired');
    retiredBox.style.display = this._showRetired ? '' : 'none';
    if (this._showRetired) {
      const retired = this._retired();
      retiredBox.innerHTML = retired.length
        ? '<p class="member-section-label">退職者（「再雇用」でリストに戻せます）</p>'
          + retired.map(m => this._rowHtml(m)).join('')
        : '<p class="info-text">退職者はいません。</p>';
    }
  },

  /** 雇用区分のラベルとCSSクラス（part_time/full_time の2値。adminは役割であって雇用区分ではない） */
  _empMeta(emp) {
    // full_time のみ社員。それ以外（part_time・想定外値）は安全側でアルバイト表示。
    return emp === 'full_time'
      ? { label: '社員',     cls: 'ft' }
      : { label: 'アルバイト', cls: 'pt' };
  },

  _rowHtml(m) {
    const isRetired = m.status === 'retired';
    const isSelf = !!m.user_id && m.user_id === AdminState.userId;
    const roleBadge =
      m.role === 'admin'   ? `<button type="button" class="role-badge admin" onclick="MemberManager.editMember('${m.id}')">管理者</button>` :
      m.role === 'manager' ? `<button type="button" class="role-badge" onclick="MemberManager.editMember('${m.id}')">店長</button>` : '';
    const emp = this._empMeta(m.employment_type);
    const empBadge = `<button type="button" class="emp-badge ${emp.cls}" onclick="MemberManager.editMember('${m.id}')">${emp.label}</button>`;
    const linkBadge = m.user_id
      ? '<span class="link-badge linked">連携済み</span>'
      : '<span class="link-badge unlinked">LINE未連携</span>';
    const action = isRetired
      ? `<button class="member-action-btn rehire" onclick="MemberManager.reactivate('${m.id}')">再雇用</button>`
      : (isSelf ? ''
        : `<button class="member-action-btn" onclick="MemberManager.retire('${m.id}')">退職</button>`);

    return `
      <div class="member-row${isRetired ? ' retired' : ''}" data-id="${m.id}">
        ${isRetired ? '' : '<span class="member-drag-handle" aria-label="並べ替え">≡</span>'}
        <span class="member-name">${escapeHtml(m.resolved_name)}${roleBadge}</span>
        ${empBadge}
        ${linkBadge}
        ${action}
      </div>
    `;
  },

  toggleRetired(checked) {
    this._showRetired = checked;
    this.renderList();
  },

  // --------------------------------------------------------
  // 追加
  // --------------------------------------------------------

  showAddForm() {
    const form = document.getElementById('member-add-form');
    if (!form) return;
    form.style.display = '';
    document.getElementById('member-add-name').value = '';
    this._addEmp = 'part_time';
    this._paintSeg('member-add-emp', this._addEmp);
    document.getElementById('member-add-name').focus();
  },

  hideAddForm() {
    const form = document.getElementById('member-add-form');
    if (form) form.style.display = 'none';
  },

  /** セグメントトグルの選択状態を塗り直す（data-{attr} が value の1つだけ on） */
  _paintSeg(containerId, value, attr) {
    attr = attr || 'emp';
    const box = document.getElementById(containerId);
    if (!box) return;
    box.querySelectorAll('.emp-seg-btn').forEach(b => {
      b.classList.toggle('on', b.dataset[attr] === value);
    });
  },

  /** 追加フォームの雇用区分を選ぶ */
  selectAddEmp(emp) {
    this._addEmp = emp;
    this._paintSeg('member-add-emp', emp);
  },

  async submitAdd() {
    const name = document.getElementById('member-add-name').value.trim();
    if (!name) {
      showToast('名前を入力してください');
      return;
    }
    const dup = this._members.find(m => m.status === 'active' && m.resolved_name === name);
    if (dup && !confirm('同じ名前のメンバーが既にいます。重複して追加しますか？')) return;

    try {
      const maxOrder = this._active()
        .reduce((mx, m) => Math.max(mx, m.sort_order || 0), -1);
      // member_code は渡さない（DB側で自動採番）。雇用区分を渡す。
      await SupaAPI.addStoreMember(this._storeId, name, this._addEmp, maxOrder + 1);
      this.hideAddForm();
      showToast(name + ' さんを追加しました（LINE未連携）');
      await this.load();
    } catch (err) {
      showToast(err.message);
      console.error('[MemberManager.submitAdd]', err);
    }
  },

  // --------------------------------------------------------
  // メンバー編集（雇用区分＋役割）モーダル
  // --------------------------------------------------------

  /** 役割の日本語ラベル */
  _roleLabel(role) {
    return role === 'admin' ? '管理者' : role === 'manager' ? '店長' : 'スタッフ';
  },

  /**
   * 役割変更セクションのHTMLを権限に応じて返す（空文字＝役割UIを出さない）。
   *   currentUserRole='admin'  : スタッフ/店長/管理者 から自由に選択
   *   currentUserRole='manager': 対象がstaffのときだけ スタッフ/店長（昇格のみ。管理者は出さない）
   *   自分自身                  : 出さない（自己昇格はDBでも拒否）
   */
  _roleControlsHtml(m) {
    const isSelf = !!m.user_id && m.user_id === AdminState.userId;
    if (isSelf) return '';
    const cur = this._currentRole();
    if (cur === 'admin') {
      return this._roleSeg(['staff', 'manager', 'admin'], m.role);
    }
    if (cur === 'manager') {
      if (m.role !== 'staff') return ''; // 店長は他の店長・管理者を降格できない
      return this._roleSeg(['staff', 'manager'], m.role);
    }
    return '';
  },

  _roleSeg(roles, current) {
    const btns = roles.map(r =>
      `<button type="button" class="emp-seg-btn${r === current ? ' on' : ''}" data-role="${r}" onclick="MemberManager.pickEditRole('${r}')">${this._roleLabel(r)}</button>`
    ).join('');
    return `<div class="emp-seg" id="member-edit-role-seg" role="group" aria-label="役割">${btns}</div>`;
  },

  editMember(memberId) {
    const m = this._members.find(x => x.id === memberId);
    if (!m) return;
    this._editId = memberId;
    this._editEmp = m.employment_type || 'part_time';
    this._editRole = m.role || 'staff';
    this._editOrigRole = this._editRole;

    document.getElementById('member-edit-name').textContent = m.resolved_name;
    this._paintSeg('member-edit-emp-seg', this._editEmp);

    const wrap = document.getElementById('member-edit-role-wrap');
    const controls = document.getElementById('member-edit-role-controls');
    const html = this._roleControlsHtml(m);
    controls.innerHTML = html;
    wrap.style.display = html ? '' : 'none';

    document.getElementById('member-edit-modal').style.display = 'flex';
  },

  pickEditEmp(emp) {
    this._editEmp = emp;
    this._paintSeg('member-edit-emp-seg', emp);
  },

  pickEditRole(role) {
    this._editRole = role;
    this._paintSeg('member-edit-role-seg', role, 'role');
  },

  closeEditMember() {
    this._editId = null;
    const modal = document.getElementById('member-edit-modal');
    if (modal) modal.style.display = 'none';
  },

  async saveEditMember() {
    if (!this._editId) return;
    const id = this._editId;
    const m = this._members.find(x => x.id === id);
    if (!m) { this.closeEditMember(); return; }

    const roleChanged = this._editRole !== this._editOrigRole;
    const empChanged = this._editEmp !== (m.employment_type || 'part_time');

    // 昇格は強い操作なので確認ダイアログ（D）
    if (roleChanged && this._editRole === 'manager') {
      if (!confirm(m.resolved_name + ' さんを店長にしますか？\n店長は自店のメンバー管理やシフト確定ができるようになります。')) return;
    }
    if (roleChanged && this._editRole === 'admin') {
      if (!confirm(m.resolved_name + ' さんを管理者にしますか？\n管理者は全店の役割変更などができるようになります。')) return;
    }

    try {
      // 役割を先に（DBガードで弾かれやすいのはこちら。失敗なら雇用区分は触らない）
      if (roleChanged) await SupaAPI.setStoreMemberRole(id, this._editRole);
      if (empChanged)  await SupaAPI.setStoreMemberEmploymentType(id, this._editEmp);
      this.closeEditMember();
      showToast('変更を保存しました');
      await this.load();
    } catch (err) {
      // DBガードに弾かれたとき等。日本語のexceptionメッセージをそのまま見せる（C）
      console.error('[MemberManager.saveEditMember]', err);
      this.closeEditMember();
      showToast(err.message, 5000);
      await this.load();
    }
  },

  // --------------------------------------------------------
  // 退職・再雇用（物理削除はしない）
  // --------------------------------------------------------

  async retire(memberId) {
    const m = this._members.find(x => x.id === memberId);
    if (!m) return;
    if (!confirm(m.resolved_name + ' さんを退職にします。\n過去の提出履歴は残ります。よろしいですか？')) return;

    try {
      await SupaAPI.retireStoreMember(memberId);
      showToast(m.resolved_name + ' さんを退職にしました');
      await this.load();
    } catch (err) {
      showToast(err.message);
      console.error('[MemberManager.retire]', err);
    }
  },

  async reactivate(memberId) {
    const m = this._members.find(x => x.id === memberId);
    if (!m) return;
    try {
      const maxOrder = this._active()
        .reduce((mx, x) => Math.max(mx, x.sort_order || 0), -1);
      await SupaAPI.reactivateStoreMember(memberId, maxOrder + 1);
      showToast(m.resolved_name + ' さんを再雇用にしました');
      await this.load();
    } catch (err) {
      showToast(err.message);
      console.error('[MemberManager.reactivate]', err);
    }
  },

  // --------------------------------------------------------
  // 並べ替え（ドラッグ＆ドロップ → 即保存）
  // --------------------------------------------------------

  _initSortable() {
    const box = document.getElementById('member-list-active');
    if (!box || typeof Sortable === 'undefined') return;
    if (this._sortable) return; // コンテナは固定なので一度だけ付ける
    this._sortable = Sortable.create(box, {
      handle           : '.member-drag-handle',
      animation        : 150,
      delay            : 150,   // スクロールと誤反応しないよう長押しで開始
      delayOnTouchOnly : true,
      onEnd            : () => this._onReorder()
    });
  },

  async _onReorder() {
    const box = document.getElementById('member-list-active');
    const orderedIds = Array.from(box.querySelectorAll('.member-row'))
      .map(el => el.dataset.id);

    // ローカル状態をDOMの並びに合わせ直す（retiredは末尾に維持）
    const retired = this._retired();
    const byId = {};
    this._members.forEach(m => { byId[m.id] = m; });
    const actives = orderedIds.map(id => byId[id]).filter(Boolean);
    actives.forEach((m, index) => { m.sort_order = index; });
    this._members = actives.concat(retired);

    try {
      await SupaAPI.reorderStoreMembers(orderedIds);
      showToast('並び順を保存しました');
    } catch (err) {
      // 原因がわかるようエラー内容をそのまま表示する
      showToast(err.message + '（読み込み直します）', 5000);
      console.error('[MemberManager._onReorder]', err);
      this.load();
    }
  }
};

// ============================================================
// たたき台編集画面
// ============================================================

const DraftEditor = {
  period   : null,
  dates    : [],     // 期間内の全日付 "YYYY-MM-DD"
  dayIndex : 0,
  members  : [],     // [{id, name, memberCode, submitted}]
  hopes    : {},     // hopes[userId][date] = {available, start, end}
  assign   : {},     // assign[userId][date] = {start, end, status}
  hasPublished: false,

  async init(period) {
    this.period = period;
    this.dates = this._datesBetween(period.start, period.end);
    this.dayIndex = 0;

    showScreen('editor');
    document.getElementById('editor-period-label').textContent = period.label;
    document.getElementById('editor-day-body').innerHTML =
      '<p class="loading-text">読み込み中…</p>';

    try {
      const data = await SupaAPI.getDraftData(period);
      this.members = data.members;
      this.hopes = data.hopes;
      this.assign = {};
      this.hasPublished = false;
      data.drafts.forEach(d => {
        const date = String(d.work_date).slice(0, 10);
        if (!this.assign[d.user_id]) this.assign[d.user_id] = {};
        this.assign[d.user_id][date] = {
          start : String(d.start_time).slice(0, 5),
          end   : String(d.end_time).slice(0, 5),
          status: d.status
        };
        if (d.status === 'published') this.hasPublished = true;
      });
      this._updatePublishBar();
      this.renderDay();
    } catch (err) {
      showError(err.message);
    }
  },

  // --------------------------------------------------------
  // 描画
  // --------------------------------------------------------

  renderDay() {
    const date = this.dates[this.dayIndex];

    document.getElementById('editor-day-label').textContent = this._formatDateLabel(date);
    document.getElementById('editor-day-pos').textContent =
      (this.dayIndex + 1) + '日目 / 全' + this.dates.length + '日';
    document.getElementById('editor-prev').disabled = this.dayIndex === 0;
    document.getElementById('editor-next').disabled = this.dayIndex === this.dates.length - 1;

    const count = this.members.filter(m => (this.assign[m.id] || {})[date]).length;
    document.getElementById('editor-day-summary').textContent =
      'この日の出勤: ' + count + '人';

    document.getElementById('editor-day-body').innerHTML =
      this.members.map((m, index) => {
        const hope = (this.hopes[m.id] || {})[date];
        const asg  = (this.assign[m.id] || {})[date];
        const hopeLabel = !hope
          ? '<span class="hope none">未提出</span>'
          : hope.available
            ? `<span class="hope ok">希望 ${hope.start}〜${hope.end}</span>`
            : '<span class="hope ng">休み希望</span>';

        return `
          <div class="staff-row${asg ? ' on' : ''}">
            <div class="staff-row-top">
              <span class="staff-name">${escapeHtml(m.name)}</span>
              ${hopeLabel}
              <button class="assign-toggle${asg ? ' on' : ''}" onclick="DraftEditor.toggle(${index})">
                ${asg ? '出勤' : '休み'}
              </button>
            </div>
            ${asg ? `
            <div class="staff-row-times">
              <select onchange="DraftEditor.onTime(${index}, 'start', this.value)">
                ${this._timeOptions(asg.start)}
              </select>
              <span>〜</span>
              <select onchange="DraftEditor.onTime(${index}, 'end', this.value)">
                ${this._timeOptions(asg.end)}
              </select>
            </div>` : ''}
          </div>
        `;
      }).join('');
  },

  /** 10:00〜23:00、30分刻みの<option>群 */
  _timeOptions(selected) {
    const opts = [];
    for (let h = 10; h <= 23; h++) {
      ['00', '30'].forEach(mm => {
        if (h === 23 && mm === '30') return;
        const t = String(h).padStart(2, '0') + ':' + mm;
        opts.push(`<option value="${t}"${t === selected ? ' selected' : ''}>${t}</option>`);
      });
    }
    return opts.join('');
  },

  prevDay() {
    if (this.dayIndex > 0) { this.dayIndex--; this.renderDay(); }
  },

  nextDay() {
    if (this.dayIndex < this.dates.length - 1) { this.dayIndex++; this.renderDay(); }
  },

  // --------------------------------------------------------
  // 編集操作（変更は即保存）
  // --------------------------------------------------------

  /** 出勤⇔休みの切り替え */
  async toggle(index) {
    const m = this.members[index];
    const date = this.dates[this.dayIndex];
    const current = (this.assign[m.id] || {})[date];

    try {
      if (current) {
        delete this.assign[m.id][date];
        this.renderDay();
        await SupaAPI.deleteDraftShift(this.period.id, m.id, date);
      } else {
        // 初期値は本人の希望時間。希望がなければディナー標準（17:00〜23:00）
        const hope = (this.hopes[m.id] || {})[date];
        const start = (hope && hope.available) ? hope.start : '17:00';
        const end   = (hope && hope.available) ? hope.end   : '23:00';
        if (!this.assign[m.id]) this.assign[m.id] = {};
        this.assign[m.id][date] = { start: start, end: end, status: 'draft' };
        this.renderDay();
        await SupaAPI.saveDraftShift(this.period, m.id, date, start, end);
      }
    } catch (err) {
      showToast('保存に失敗しました。読み込み直します');
      console.error('[DraftEditor.toggle]', err);
      this.init(this.period);
    }
  },

  /** 時刻の変更 */
  async onTime(index, which, value) {
    const m = this.members[index];
    const date = this.dates[this.dayIndex];
    const asg = (this.assign[m.id] || {})[date];
    if (!asg) return;

    const before = asg[which];
    asg[which] = value;
    if (asg.start >= asg.end) {
      asg[which] = before;
      showToast('終了時刻は開始時刻より後にしてください');
      this.renderDay();
      return;
    }

    try {
      await SupaAPI.saveDraftShift(this.period, m.id, date, asg.start, asg.end);
    } catch (err) {
      showToast('保存に失敗しました。読み込み直します');
      console.error('[DraftEditor.onTime]', err);
      this.init(this.period);
    }
  },

  /** 提出された希望を、未割当のコマにまとめて取り込む */
  async copyFromHopes() {
    const rows = [];
    this.members.forEach(m => {
      const hopeDates = this.hopes[m.id] || {};
      Object.keys(hopeDates).forEach(date => {
        const hope = hopeDates[date];
        if (!hope.available) return;
        if ((this.assign[m.id] || {})[date]) return; // 既に割当済みは触らない
        rows.push({ userId: m.id, date: date, start: hope.start, end: hope.end });
      });
    });

    if (!rows.length) {
      showToast('取り込める希望はありません（すべて割当済みです）');
      return;
    }
    if (!confirm(rows.length + 'コマを希望どおりに割り当てます。\n（割当済みのコマは変更されません）\nよろしいですか？')) {
      return;
    }

    try {
      await SupaAPI.createDraftFromHopes(this.period, rows);
      showToast(rows.length + 'コマを取り込みました');
      await this.init(this.period);
    } catch (err) {
      showToast(err.message);
      console.error('[DraftEditor.copyFromHopes]', err);
    }
  },

  /** 確定（公開）。公開後の変更も、もう一度押せば反映される */
  async publish() {
    const message = this.hasPublished
      ? 'たたき台の変更内容を公開します。よろしいですか？'
      : 'この期間のシフトを確定して、スタッフに公開します。よろしいですか？';
    if (!confirm(message)) return;

    try {
      await SupaAPI.publishPeriod(this.period.id);
      this.hasPublished = true;
      Object.keys(this.assign).forEach(uid => {
        Object.keys(this.assign[uid]).forEach(d => {
          this.assign[uid][d].status = 'published';
        });
      });
      this._updatePublishBar();
      showToast('公開しました。スタッフのアプリに表示されます');
    } catch (err) {
      showToast(err.message);
      console.error('[DraftEditor.publish]', err);
    }
  },

  _updatePublishBar() {
    const badge = document.getElementById('editor-published-badge');
    const btn = document.getElementById('editor-publish-btn');
    if (badge) badge.classList.toggle('visible', this.hasPublished);
    if (btn) btn.textContent = this.hasPublished ? '変更を公開する ✓' : '確定して公開する ✓';
  },

  // --------------------------------------------------------
  // 日付ヘルパー
  // --------------------------------------------------------

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
  },

  _formatDateLabel(dateStr) {
    const parts = dateStr.split('-').map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    const youbi = ['日', '月', '火', '水', '木', '金', '土'][date.getDay()];
    return parts[1] + '月' + parts[2] + '日（' + youbi + '）';
  }
};

// ============================================================
// エントリーポイント
// ============================================================

async function initApp() {
  try {
    await liff.init({ liffId: CONFIG_V2.LIFF_ID });
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }

    SupaAPI.init();
    const result = await SupaAPI.login();
    if (result.status === 'need_registration') {
      showError('先にシフト提出アプリで初回登録を済ませてください。');
      return;
    }

    const me = await SupaAPI.getMe();
    AdminState.userId      = me.profile.id;
    AdminState.displayName = me.profile.display_name;
    AdminState.managed     = me.memberships.filter(
      m => m.role === 'admin' || m.role === 'manager');

    if (!AdminState.managed.length) {
      showError('このページは店長専用です。');
      return;
    }

    const nameEl = document.getElementById('admin-member-name');
    if (nameEl) nameEl.textContent = AdminState.displayName || '';

    // アレグリア運用ではこのページはメンバー管理専用として使う。
    // 期間一覧→たたき台編集（AdminPeriods / DraftEditor）はシフトを
    // スプレッドシートで組む運用のため出番がなく、商品化用に温存している。
    // 再表示する場合はここを AdminPeriods.init() に戻す。
    MemberManager.open();

  } catch (err) {
    console.error('[initApp] 起動エラー:', err);
    showError('起動に失敗しました。\n\n' + err.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  const loadingScreen = document.getElementById('screen-loading');
  if (loadingScreen) loadingScreen.classList.add('active');
  initApp();
});
