/**
 * アレグリア シフト管理ツール - 提出リマインド設定（reminder.html 専用）
 *
 * 店長が「締切の何日前・何時に・誰に・どんな文面で」LINEを送るかを設定する画面。
 * これまで店長がLINE公式アカウントのアプリ側で手作業で組んでいた配信予約を、
 * このアプリの中で完結させる。
 *
 * 設計上の約束（既存の動いている仕組みを壊さないための線引き）:
 *   - 認証は api_v2.js の SupaAPI をそのまま使う。ここで独自にトークンを取りに
 *     行かない。IDトークンの期限切れ自動取り直し（_forceRelogin）は SupaAPI 側に
 *     入っているので、SupaAPI.login() を通す限りその恩恵をそのまま受けられる。
 *   - 期間セレクタは作らない。この画面が見るのは status='open' の直近1期間だけ。
 *   - 対象者の判定はフロントでやらない。人数は必ず get_reminder_preview に聞く
 *     （分母の定義＝include_in_submission=true はDB側に一本化されている）。
 *   - get_reminder_targets は呼ばない（LINE IDを返す運営専用関数。実行権限もない）。
 *   - このページ用の処理はすべてこのファイルに書く。既存JSには一切足さない。
 *
 * ロード順: config_v2.js → api_v2.js → reminder.js
 */

// リマインド送信 Edge Function。config_v2.js（既存ファイル）は変更しない方針なので
// このページ専用の定数としてここに置く。
const REMINDER_FN_URL = CONFIG_V2.SUPABASE_URL + '/functions/v1/send-reminders';

// 店長トップへの戻り先。?v= はこの画面の追加に合わせたキャッシュバスター。
const MANAGER_HOME_URL = 'manager-home.html?v=20260731-v1-reminder';

// LINE無料プランの月間上限200通に対する警告ライン
const QUOTA_LIMIT = 200;
const QUOTA_WARN  = 180;

// 選択肢は増やさない（店長がIT非リテラシー前提。初期値のまま正しく動くことを優先）
const DAYS_BEFORE_OPTIONS = [
  { value: 0, label: '当日'   },
  { value: 1, label: '前日'   },
  { value: 2, label: '2日前' },
  { value: 3, label: '3日前' },
  { value: 5, label: '5日前' },
  { value: 7, label: '7日前' }
];
const HOUR_OPTIONS   = [9, 11, 12, 15, 18, 20, 21, 22, 23];
const TARGET_OPTIONS = [
  { value: 'all',         label: '全員'           },
  { value: 'unsubmitted', label: '未提出の人だけ' }
];

// 送信履歴の表示ラベル（reminder_logs.kind / status）
const LOG_KIND_LABELS = {
  scheduled: '自動',
  manual   : '手動',
  test     : 'テスト'
};
const LOG_STATUS_LABELS = {
  sending  : '送信中',
  sent     : '成功',
  failed   : '失敗',
  no_target: '対象者なし'
};

// 新しいタイミングを追加したときの既定文面
const DEFAULT_TEMPLATE =
  '{名前}さん\n' +
  '{期間}のシフト希望の提出期限は {締切} です。\n' +
  'まだの方はこちらからお願いします。\n' +
  '{URL}';

// ============================================================
// 状態（このページ専用）
// ============================================================

const RmdState = {
  userId     : null,
  displayName: null,
  managed    : [],    // 店長権限(admin/manager)を持つ所属
  storeId    : null,  // 表示中の店舗
  memberId   : null,  // ログイン中の店長自身の store_members.id（テスト送信の宛先）
  enabled    : false, // reminder_settings.is_enabled（既定は必ず false）
  enabledAtLoad: false, // 読み込み直後の is_enabled（変更検知用）
  hasSettings: false, // reminder_settings に行があるか
  rows       : [],    // 編集中のタイミング
  original   : [],    // 読み込み直後のスナップショット（差分計算用）
  deletedIds : [],    // 保存時にDELETEするID
  period     : null,  // status='open' の直近1期間
  preview    : null,  // {target_all, target_unsubmitted, unsubmitted_names}
  logs       : [],
  busy       : false  // 保存・送信中の二重実行防止
};

// ============================================================
// 汎用ユーティリティ（manager_home.js と同じ作法。共有はせず個別に持つ）
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
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 店舗切替タブ用の短縮表示名（manager-home と同じ規則） */
const SHORT_STORE_NAMES = { dummy01: 'テスト店' };

function shortStoreName(membership) {
  const key = membership.store_key || '';
  if (SHORT_STORE_NAMES[key]) return SHORT_STORE_NAMES[key];
  let name = String(membership.store_name || '');
  name = name.replace(/^アレグリア\s*/, '').replace(/【[^】]*】/g, '').trim();
  if (!name) name = String(membership.store_name || '');
  return name.length > 6 ? name.slice(0, 6) + '…' : name;
}

// ------------------------------------------------------------
// 日時（すべてJST固定。端末のタイムゾーンに依存させない）
// ------------------------------------------------------------

/**
 * timestamptz 文字列を Date に正規化する。
 * PostgRESTは "2026-08-10T14:59:00+00:00" だが、経路によっては
 * スペース区切り・"+00"（2桁だけのオフセット）で来ることがある。
 */
function parseTimestamp(ts) {
  if (!ts) return null;
  const iso = String(ts).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Date → 日本時間のカレンダー日付 {y, m, d}。端末TZに依存しない。 */
function toJstDateParts(date) {
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
  const [y, m, d] = s.split('-').map(Number);
  return { y: y, m: m, d: d };
}

/**
 * 締切（timestamptz）から「送信予定日時（JST）」を求める。
 *   締切をJSTの暦日に直す → その日から days_before 日を引く → 時刻を当てる
 * 日付の引き算は UTC の暦日として行う（Date.UTC + getUTC*）ので、
 * 実行端末のタイムゾーンがどこでも同じ結果になる。
 * @returns {{y,m,d,dow,hour,minute}|null}
 */
function calcSendAt(deadline, daysBefore, hour, minute) {
  const dl = parseTimestamp(deadline);
  if (!dl) return null;
  const p = toJstDateParts(dl);
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d));
  base.setUTCDate(base.getUTCDate() - (Number(daysBefore) || 0));
  return {
    y     : base.getUTCFullYear(),
    m     : base.getUTCMonth() + 1,
    d     : base.getUTCDate(),
    dow   : base.getUTCDay(),
    hour  : Number(hour) || 0,
    minute: Number(minute) || 0
  };
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** calcSendAt() の結果 → "8月10日(月) 12:00" */
function formatSendAt(s) {
  if (!s) return '—';
  return s.m + '月' + s.d + '日(' + WEEKDAYS[s.dow] + ') ' + pad2(s.hour) + ':' + pad2(s.minute);
}

/** timestamptz → 日本時間の "8月10日(月) 12:00"（送信履歴用） */
function formatJstDateTime(ts) {
  const d = parseTimestamp(ts);
  if (!d) return String(ts || '—');
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  // 曜日はJST暦日から自前で出す（ロケール表記の揺れを避ける）
  const dow = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay();
  return Number(p.month) + '月' + Number(p.day) + '日(' + WEEKDAYS[dow] + ') '
    + p.hour + ':' + p.minute;
}

/** 締切（timestamptz）→ 日本時間の "8月10日(月) 23:59" */
function formatDeadline(ts) {
  return formatJstDateTime(ts);
}

// ============================================================
// 本体
// ============================================================

const Reminder = {

  _selectedStore() {
    return RmdState.managed.find(m => m.store_id === RmdState.storeId) || null;
  },

  // --------------------------------------------------------
  // 読み込み
  // --------------------------------------------------------

  /** ヘッダー（店名）を描画 */
  _renderHeader() {
    const store = this._selectedStore();
    const el = document.getElementById('rmd-store-name');
    if (el) el.textContent = store ? store.store_name : '';
  },

  /** 店舗切替カード（掛け持ち店長のときだけ表示。manager-home と同じ判定） */
  _renderStoreSwitch() {
    const card = document.getElementById('rmd-store-switch');
    if (!card) return;
    if (RmdState.managed.length < 2) {
      card.style.display = 'none';
      card.innerHTML = '';
      return;
    }
    card.style.display = '';
    card.innerHTML = `
      <p class="rmd-switch-title">🏪 店舗を切り替え</p>
      <div class="rmd-switch-tabs">` +
      RmdState.managed.map(m => `
        <button type="button" class="rmd-switch-tab${m.store_id === RmdState.storeId ? ' on' : ''}"
          data-store="${escapeHtml(m.store_id)}">${escapeHtml(shortStoreName(m))}</button>
      `).join('') + `
      </div>`;

    card.querySelectorAll('.rmd-switch-tab').forEach(btn => {
      btn.addEventListener('click', () => this.switchStore(btn.dataset.store));
    });
  },

  async switchStore(storeId) {
    if (RmdState.busy) return;
    if (!RmdState.managed.some(m => m.store_id === storeId)) return;
    if (storeId === RmdState.storeId) return;
    if (this._isDirty() && !confirm('保存していない変更があります。破棄して店舗を切り替えますか？')) {
      return;
    }
    RmdState.storeId = storeId;
    await this.load();
  },

  /**
   * 表示中の店舗のデータを読み直す。
   * 期間は status='open' の直近1件のみ（期間セレクタは作らない）。
   */
  async load() {
    const storeId = RmdState.storeId;

    RmdState.rows       = [];
    RmdState.original   = [];
    RmdState.deletedIds = [];
    RmdState.period     = null;
    RmdState.preview    = null;
    RmdState.logs       = [];
    RmdState.memberId   = null;

    this._renderHeader();
    this._renderStoreSwitch();
    this._renderActions();   // 読み込み中は期間が未確定なので送信系は止めておく
    document.getElementById('rmd-sched-list').innerHTML =
      '<p class="loading-text">読み込み中…</p>';
    document.getElementById('rmd-next').innerHTML =
      '<p class="loading-text">読み込み中…</p>';
    document.getElementById('rmd-logs').innerHTML =
      '<p class="loading-text">読み込み中…</p>';

    try {
      const db = SupaAPI.db;

      // 1. ON/OFF（行が無い店もある。作るのは保存時）
      const st = await db.from('reminder_settings')
        .select('store_id, is_enabled')
        .eq('store_id', storeId)
        .maybeSingle();
      if (st.error) throw new Error('リマインド設定の取得に失敗しました: ' + st.error.message);
      // 行が無い店は「OFF」として扱う。ここでも保存時でも、勝手にONにはしない。
      RmdState.hasSettings   = !!st.data;
      RmdState.enabled       = st.data ? !!st.data.is_enabled : false;
      RmdState.enabledAtLoad = RmdState.enabled;

      // 2. 送信タイミング
      const sc = await db.from('reminder_schedules')
        .select('id, store_id, days_before, send_hour, send_minute, target, message_template, is_enabled, sort_order')
        .eq('store_id', storeId)
        .order('sort_order', { ascending: true });
      if (sc.error) throw new Error('送信タイミングの取得に失敗しました: ' + sc.error.message);
      RmdState.rows     = (sc.data || []).map(r => this._toRow(r));
      RmdState.original = RmdState.rows.map(r => ({ ...r }));

      // 3. 受付中の期間（直近1件だけ）。
      //    並びは deadline の昇順＝送信側 Edge Function と同じ選び方にする。
      //    start_date 順にすると、受付中の期間が一時的に2つ存在したときに
      //    「画面に出ている期間」と「実際に送られる期間」がズレうる。
      const pe = await db.from('shift_periods')
        .select('id, store_id, title, start_date, end_date, deadline, status')
        .eq('store_id', storeId)
        .eq('status', 'open')
        .order('deadline', { ascending: true })
        .limit(1);
      if (pe.error) throw new Error('提出期間の取得に失敗しました: ' + pe.error.message);
      RmdState.period = (pe.data || [])[0] || null;

      // 4. 人数（対象者の定義はDB側。フロントで絞り込まない）
      if (RmdState.period) {
        const pv = await db.rpc('get_reminder_preview', {
          p_store_id : storeId,
          p_period_id: RmdState.period.id
        });
        if (pv.error) throw new Error('対象人数の取得に失敗しました: ' + pv.error.message);
        RmdState.preview = Array.isArray(pv.data) ? (pv.data[0] || null) : (pv.data || null);
      }

      // 5. ログイン中の店長自身の store_members.id（テスト送信の宛先。他人は選べない）
      const me = await db.from('store_members')
        .select('id')
        .eq('store_id', storeId)
        .eq('user_id', SupaAPI.user.id)
        .maybeSingle();
      if (me.error) throw new Error('メンバー情報の取得に失敗しました: ' + me.error.message);
      RmdState.memberId = me.data ? me.data.id : null;

      // 6. 送信履歴（参照のみ）。ここが取れなくても設定は使えるようにしたいので、
      //    失敗しても履歴パネルだけを空にして先へ進む。
      RmdState.logs = [];
      let logError = null;
      try {
        RmdState.logs = await this._loadLogs(storeId);
      } catch (e) {
        console.warn('[Reminder.load] 送信履歴を取得できません:', e);
        logError = e;
      }

      this._renderAll();
      if (logError) {
        document.getElementById('rmd-logs').innerHTML =
          `<p class="error-text">${escapeHtml(logError.message)}</p>`;
      }

    } catch (err) {
      console.error('[Reminder.load]', err);
      document.getElementById('rmd-sched-list').innerHTML =
        `<p class="error-text">${escapeHtml(err.message)}</p>`;
      document.getElementById('rmd-next').innerHTML = '';
      document.getElementById('rmd-logs').innerHTML = '';
    }
  },

  /**
   * 送信履歴（直近5件）。reminder_logs は参照のみ（RLSでも店長はSELECTだけ）。
   * 並び順は created_at の降順。sent_at は送信完了時にしか入らずNULLがありうるため、
   * 並べ替えのキーには使わない。
   */
  async _loadLogs(storeId) {
    const res = await SupaAPI.db.from('reminder_logs')
      .select('id, kind, target, status, recipient_count, error, scheduled_for, created_at, sent_at')
      .eq('store_id', storeId)
      .order('created_at', { ascending: false })
      .limit(5);
    if (res.error) throw new Error('送信履歴の取得に失敗しました: ' + res.error.message);
    return res.data || [];
  },

  /** DBの行 → 画面の行 */
  _toRow(r) {
    return {
      id              : r.id,
      days_before     : Number(r.days_before) || 0,
      send_hour       : Number(r.send_hour) || 0,
      send_minute     : Number(r.send_minute) || 0,
      target          : r.target === 'unsubmitted' ? 'unsubmitted' : 'all',
      message_template: r.message_template || '',
      is_enabled      : r.is_enabled !== false,
      sort_order      : Number(r.sort_order) || 0
    };
  },

  // --------------------------------------------------------
  // 描画
  // --------------------------------------------------------

  _renderAll() {
    this._renderToggle();
    this._renderSchedules();
    this._renderNext();
    this._renderActions();
    this._renderLogs();
  },

  /**
   * 送信系ボタンの活殺。
   * 受付中の期間が無いと、送っても Edge Function 側が400を返すだけで、
   * 手前の確認ダイアログも「0名に送信します」という意味のない文言になる。
   * 送れないことを先に伝えて、ボタン自体を押せなくする。
   * 設定の編集・保存は期間が無くてもできる（＝［保存］は止めない）。
   */
  _renderActions() {
    const sendable = !!RmdState.period;
    ['rmd-test', 'rmd-now'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = !sendable;
    });
    const note = document.getElementById('rmd-send-note');
    if (note) {
      note.style.display = sendable ? 'none' : '';
      note.textContent   = sendable ? '' : '受付中の提出期間がないため、いまは送信できません。';
    }
  },

  _renderToggle() {
    const btn  = document.getElementById('rmd-toggle');
    const note = document.getElementById('rmd-toggle-note');
    if (!btn) return;
    btn.classList.toggle('on', RmdState.enabled);
    btn.setAttribute('aria-pressed', RmdState.enabled ? 'true' : 'false');
    btn.querySelector('.rmd-toggle-text').textContent = RmdState.enabled ? 'ON' : 'OFF';
    if (note) {
      note.textContent = RmdState.enabled
        ? '下の送信タイミングにそって、自動でLINEが届きます。'
        : 'いまは自動送信されません。送信タイミングの設定は保存できます。';
    }
  },

  _renderSchedules() {
    const list = document.getElementById('rmd-sched-list');
    if (!list) return;

    if (!RmdState.rows.length) {
      list.innerHTML = '<p class="info-text">送信タイミングがまだありません。<br>下の「＋ タイミングを追加」から作成してください。</p>';
      return;
    }

    list.innerHTML = RmdState.rows.map((row, i) => {
      const daysOpts = this._options(
        DAYS_BEFORE_OPTIONS.map(o => ({ value: o.value, label: o.label })), row.days_before);
      const hourOpts = this._options(
        this._hourOptions(row.send_hour, row.send_minute), row.send_hour);
      const tgtOpts  = this._options(TARGET_OPTIONS, row.target);

      return `
        <div class="rmd-sched${row.is_enabled ? '' : ' off'}">
          <div class="rmd-sched-head">
            <span class="rmd-sched-cap">締切</span>
            <select class="rmd-select" data-idx="${i}" data-field="days_before">${daysOpts}</select>
            <select class="rmd-select" data-idx="${i}" data-field="send_hour">${hourOpts}</select>
            <span class="rmd-sched-cap">宛先</span>
            <select class="rmd-select" data-idx="${i}" data-field="target">${tgtOpts}</select>
            ${row.is_enabled ? '' : '<span class="rmd-badge-off">停止中</span>'}
            <button type="button" class="rmd-sched-del" data-idx="${i}">削除</button>
          </div>
          <span class="field-label">文面</span>
          <textarea class="rmd-textarea" maxlength="500"
            data-idx="${i}" data-field="message_template"
            placeholder="送りたい文面を入力してください">${escapeHtml(row.message_template)}</textarea>
          <p class="rmd-ph-hint">{名前} {期間} {締切} {URL} が使えます（送信時に自動で置き換わります）</p>
        </div>`;
    }).join('');

    list.querySelectorAll('select[data-field], textarea[data-field]').forEach(el => {
      const handler = () => {
        const row   = RmdState.rows[Number(el.dataset.idx)];
        const field = el.dataset.field;
        if (!row) return;
        if (field === 'days_before' || field === 'send_hour') {
          row[field] = Number(el.value);
          this._renderNext();
        } else if (field === 'target') {
          row.target = el.value;
          this._renderNext();
        } else {
          row.message_template = el.value;
          el.classList.remove('input-error');
        }
      };
      el.addEventListener('change', handler);
      if (el.tagName === 'TEXTAREA') el.addEventListener('input', handler);
    });

    list.querySelectorAll('.rmd-sched-del').forEach(btn => {
      btn.addEventListener('click', () => this.removeRow(Number(btn.dataset.idx)));
    });
  },

  /** <option> を組み立てる（selected付き） */
  _options(options, current) {
    return options.map(o =>
      `<option value="${escapeHtml(o.value)}"${String(o.value) === String(current) ? ' selected' : ''}>`
      + escapeHtml(o.label) + '</option>'
    ).join('');
  },

  /**
   * 時刻の選択肢。分は常に00（選択肢を増やさない方針）だが、
   * 既存行が一覧に無い時刻・分を持っている場合は、その値を消してしまわないよう
   * 選択肢として1つだけ足す。
   */
  _hourOptions(currentHour, currentMinute) {
    const opts = HOUR_OPTIONS.map(h => ({ value: h, label: pad2(h) + ':00' }));
    if (!HOUR_OPTIONS.includes(Number(currentHour)) || Number(currentMinute) !== 0) {
      opts.push({
        value: Number(currentHour),
        label: pad2(currentHour) + ':' + pad2(currentMinute)
      });
      opts.sort((a, b) => a.value - b.value);
    }
    return opts;
  },

  /** 次回送信予定と通数見込み */
  _renderNext() {
    const box = document.getElementById('rmd-next');
    if (!box) return;

    if (!RmdState.period) {
      box.innerHTML = '<p class="info-text">いま受付中の期間がありません。<br>期間が開くと送信予定がここに表示されます。</p>';
      return;
    }

    const period = RmdState.period;
    const pv     = RmdState.preview || {};
    const all    = Number(pv.target_all) || 0;
    const unsub  = Number(pv.target_unsubmitted) || 0;

    const active = RmdState.rows.filter(r => r.is_enabled);
    if (!active.length) {
      box.innerHTML = `
        <p class="info-text">送信タイミングがありません。</p>
        <p class="rmd-panel-note">対象期間: ${escapeHtml(period.title)}（締切 ${escapeHtml(formatDeadline(period.deadline))}）</p>`;
      return;
    }

    // 送信日時の早い順に並べて表示（保存順ではなく実際に届く順）
    const items = active
      .map(r => ({ row: r, at: calcSendAt(period.deadline, r.days_before, r.send_hour, r.send_minute) }))
      .sort((a, b) => this._sendAtKey(a.at) - this._sendAtKey(b.at));

    const perPeriod = active.reduce(
      (sum, r) => sum + (r.target === 'all' ? all : unsub), 0);
    const monthly = perPeriod * 2;   // 月2期間ぶん

    const rowsHtml = items.map(it => {
      const who = it.row.target === 'all'
        ? all + '名'
        : '未提出のみ（現在' + unsub + '名）';
      return `
        <div class="rmd-next-item">
          <span class="rmd-next-when">${escapeHtml(formatSendAt(it.at))}</span>
          <span class="rmd-next-who">→ ${escapeHtml(who)}</span>
        </div>`;
    }).join('');

    const warn = monthly > QUOTA_WARN;
    box.innerHTML = rowsHtml + `
      <div class="rmd-quota${warn ? ' warn' : ''}">
        今月の使用見込み: ${monthly}通 / ${QUOTA_LIMIT}通
        ${warn ? '<br>⚠️ LINE無料プランの上限（月' + QUOTA_LIMIT + '通）に近づいています。' : ''}
      </div>
      <p class="rmd-panel-note">
        対象期間: ${escapeHtml(period.title)}（締切 ${escapeHtml(formatDeadline(period.deadline))}）<br>
        見込みは「1期間ぶん × 2」で計算しています。
        ${RmdState.enabled ? '' : '<br>※ いまリマインドはOFFのため、実際には送信されません。'}
      </p>`;
  },

  /** 送信予定の並べ替え用キー */
  _sendAtKey(at) {
    if (!at) return Number.MAX_SAFE_INTEGER;
    return Date.UTC(at.y, at.m - 1, at.d, at.hour, at.minute);
  },

  _renderLogs() {
    const box = document.getElementById('rmd-logs');
    if (!box) return;
    if (!RmdState.logs.length) {
      box.innerHTML = '<p class="info-text">送信履歴はまだありません。</p>';
      return;
    }
    box.innerHTML = RmdState.logs.map(log => {
      // 送信完了していれば sent_at、まだなら created_at を表示する
      const when   = formatJstDateTime(log.sent_at || log.created_at);
      const kind   = LOG_KIND_LABELS[log.kind] || log.kind || '';
      const status = LOG_STATUS_LABELS[log.status] || log.status || '';
      const tgt    = log.target === 'unsubmitted' ? '未提出のみ'
                   : log.target === 'all'         ? '全員' : '';
      const count  = log.recipient_count == null ? '' : log.recipient_count + '件';
      const sub    = [kind, tgt, count].filter(Boolean).join(' ・ ');

      // エラー本文は失敗したときだけ出す（成功時に赤字が出ると無用に不安にさせる）
      const err = (log.status === 'failed' && log.error)
        ? `<p class="rmd-log-err">${escapeHtml(log.error)}</p>` : '';

      return `
        <div class="rmd-log">
          <div class="rmd-log-when">
            ${escapeHtml(when)}
            <span class="rmd-log-status ${escapeHtml(log.status || '')}">${escapeHtml(status)}</span>
          </div>
          <div class="rmd-log-sub">${escapeHtml(sub)}</div>
          ${err}
        </div>`;
    }).join('');
  },

  // --------------------------------------------------------
  // 編集
  // --------------------------------------------------------

  toggleEnabled() {
    RmdState.enabled = !RmdState.enabled;
    this._renderToggle();
    this._renderNext();
  },

  addRow() {
    RmdState.rows.push({
      id              : null,
      days_before     : 0,
      send_hour       : 12,
      send_minute     : 0,
      target          : 'all',
      message_template: DEFAULT_TEMPLATE,
      is_enabled      : true,
      sort_order      : RmdState.rows.length
    });
    this._renderSchedules();
    this._renderNext();
  },

  removeRow(index) {
    const row = RmdState.rows[index];
    if (!row) return;
    if (!confirm('この送信タイミングを削除します。よろしいですか？\n（［保存］を押すまでDBには反映されません）')) return;
    if (row.id) RmdState.deletedIds.push(row.id);
    RmdState.rows.splice(index, 1);
    this._renderSchedules();
    this._renderNext();
  },

  /** 未保存の変更があるか */
  _isDirty() {
    if (RmdState.deletedIds.length) return true;
    if (RmdState.rows.length !== RmdState.original.length) return true;
    if (RmdState.rows.some(r => !r.id)) return true;
    const byId = {};
    RmdState.original.forEach(o => { byId[o.id] = o; });
    return RmdState.rows.some((r, i) => {
      const o = byId[r.id];
      if (!o) return true;
      return o.days_before !== r.days_before
        || o.send_hour   !== r.send_hour
        || o.send_minute !== r.send_minute
        || o.target      !== r.target
        || o.message_template !== r.message_template
        || o.is_enabled  !== r.is_enabled
        || o.sort_order  !== i;
    }) || this._settingsDirty();
  },

  /**
   * ON/OFF が読み込み時から変わっているか。
   * reminder_settings に行が無い店は「OFF」と同じ状態なので、
   * 行が無いこと自体は「未保存の変更」とは見なさない（保存時に作られる）。
   */
  _settingsDirty() {
    return RmdState.enabled !== RmdState.enabledAtLoad;
  },

  // --------------------------------------------------------
  // 保存
  // --------------------------------------------------------

  /**
   * 一括保存。
   * 「全削除して全挿入」はしない。id を保持したまま更新することで、
   * reminder_logs.schedule_id からの参照（送信履歴とのつながり）を切らない。
   * 発行順は DELETE → UPDATE → INSERT。
   * unique(store_id, days_before, send_hour, send_minute) と衝突しないよう、
   * 先に削除して枠を空けてから追加する。
   */
  async save() {
    if (RmdState.busy) return;

    // 重複チェック（DBのunique制約に当てる前にフロントで気づかせる）
    const seen = {};
    for (const r of RmdState.rows) {
      const key = r.days_before + '-' + r.send_hour + '-' + r.send_minute;
      if (seen[key]) {
        this._actionMessage('同じタイミングがすでにあります（' +
          this._labelOf(DAYS_BEFORE_OPTIONS, r.days_before) + ' ' +
          pad2(r.send_hour) + ':' + pad2(r.send_minute) +
          '）。日付か時刻を変えてください。', true);
        return;
      }
      seen[key] = true;
    }

    // 空の文面は送っても意味がないので弾く
    const emptyIdx = RmdState.rows.findIndex(r => !String(r.message_template).trim());
    if (emptyIdx >= 0) {
      this._actionMessage('文面が空のタイミングがあります。入力してください。', true);
      const el = document.querySelector(
        `textarea[data-idx="${emptyIdx}"][data-field="message_template"]`);
      if (el) { el.classList.add('input-error'); el.focus(); }
      return;
    }

    this._setBusy(true, 'save');
    this._actionMessage('');

    try {
      const db      = SupaAPI.db;
      const storeId = RmdState.storeId;

      // 1. DELETE
      if (RmdState.deletedIds.length) {
        const del = await db.from('reminder_schedules')
          .delete()
          .eq('store_id', storeId)
          .in('id', RmdState.deletedIds);
        if (del.error) throw new Error('削除に失敗しました: ' + del.error.message);
        RmdState.deletedIds = [];
      }

      // 2. UPDATE（id を保持したまま更新する）
      const originalById = {};
      RmdState.original.forEach(o => { originalById[o.id] = o; });

      for (let i = 0; i < RmdState.rows.length; i++) {
        const r = RmdState.rows[i];
        if (!r.id) continue;
        const o = originalById[r.id];
        const changed = !o
          || o.days_before !== r.days_before
          || o.send_hour   !== r.send_hour
          || o.send_minute !== r.send_minute
          || o.target      !== r.target
          || o.message_template !== r.message_template
          || o.is_enabled  !== r.is_enabled
          || o.sort_order  !== i;
        if (!changed) continue;

        const up = await db.from('reminder_schedules')
          .update({
            days_before     : r.days_before,
            send_hour       : r.send_hour,
            send_minute     : r.send_minute,
            target          : r.target,
            message_template: r.message_template,
            is_enabled      : r.is_enabled,
            sort_order      : i
          })
          .eq('id', r.id)
          .eq('store_id', storeId);
        if (up.error) {
          // 2つの行の時刻を「入れ替える」編集は、UPDATEの途中で一瞬だけ
          // unique(store_id, days_before, send_hour, send_minute) に当たる。
          // DBの生メッセージ（duplicate key value violates…）は店長には読めないので、
          // 何をすれば直るかだけを伝える。
          if (up.error.code === '23505') {
            throw new Error(
              '同じ時刻どうしの入れ替えは、一度にまとめて保存できません。\n' +
              'お手数ですが、1つずつ変更して保存してください。');
          }
          throw new Error('更新に失敗しました: ' + up.error.message);
        }
      }

      // 3. INSERT
      const newRows = RmdState.rows
        .map((r, i) => ({ r: r, i: i }))
        .filter(x => !x.r.id);
      if (newRows.length) {
        const ins = await db.from('reminder_schedules')
          .insert(newRows.map(x => ({
            store_id        : storeId,
            days_before     : x.r.days_before,
            send_hour       : x.r.send_hour,
            send_minute     : x.r.send_minute,
            target          : x.r.target,
            message_template: x.r.message_template,
            is_enabled      : x.r.is_enabled,
            sort_order      : x.i
          })));
        if (ins.error) throw new Error('追加に失敗しました: ' + ins.error.message);
      }

      // 4. ON/OFF（行が無ければ作る。既定は false のまま＝勝手にONにしない）
      const set = await db.from('reminder_settings')
        .upsert({ store_id: storeId, is_enabled: RmdState.enabled }, { onConflict: 'store_id' });
      if (set.error) throw new Error('ON/OFFの保存に失敗しました: ' + set.error.message);

      showToast('保存しました');
      await this.load();

    } catch (err) {
      console.error('[Reminder.save]', err);
      this._actionMessage(err.message, true);
    } finally {
      this._setBusy(false);
    }
  },

  _labelOf(options, value) {
    const hit = options.find(o => String(o.value) === String(value));
    return hit ? hit.label : String(value);
  },

  // --------------------------------------------------------
  // 送信（Edge Function）
  // --------------------------------------------------------

  /**
   * send-reminders を叩く。認可は Edge Function 側（is_manager_of）が判定する。
   * アクセストークンは supabase-js が持っているセッションから取る＝
   * 認証経路は SupaAPI と同じで、独自のトークン取得は一切しない。
   */
  async _callFunction(payload) {
    const { data: { session } } = await SupaAPI.db.auth.getSession();
    if (!session) {
      throw new Error('ログイン情報が切れています。画面を開き直してください。');
    }
    const res = await fetch(REMINDER_FN_URL, {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
        'apikey'       : CONFIG_V2.SUPABASE_ANON_KEY
      },
      body: JSON.stringify(payload)
    });
    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw new Error('送信サーバーの応答を解析できませんでした (HTTP ' + res.status + ')');
    }
    if (!res.ok) {
      throw new Error('送信に失敗しました (HTTP ' + res.status + '): '
        + (body.message || body.error || JSON.stringify(body)));
    }
    return body;
  },

  /** 送信系の共通の後始末（結果表示・履歴の読み直し） */
  async _afterSend(result) {
    const sent   = Number(result.sent) || 0;
    const errors = Array.isArray(result.errors) ? result.errors : [];
    if (errors.length) {
      this._actionMessage(
        sent + '件送信しました。' + errors.length + '件でエラーが出ています。\n'
        + errors.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n'),
        true);
    } else {
      showToast(sent + '件送信しました');
      this._actionMessage('');
    }
    try {
      RmdState.logs = await this._loadLogs(RmdState.storeId);
      this._renderLogs();
    } catch (e) {
      console.warn('[Reminder._afterSend] 履歴の再取得に失敗:', e);
    }
  },

  /** 自分にテスト送信（宛先はログイン中の店長自身のみ。他人は選べない） */
  async sendTest() {
    if (RmdState.busy) return;
    if (!RmdState.period) {
      this._actionMessage('受付中の提出期間がないため、いまは送信できません。', true);
      return;
    }
    const store = this._selectedStore();
    if (!store || !store.store_key) {
      this._actionMessage('店舗情報を取得できませんでした。', true);
      return;
    }
    if (!RmdState.memberId) {
      this._actionMessage('ご自身のメンバー情報が見つかりませんでした。テスト送信はできません。', true);
      return;
    }
    if (this._isDirty()) {
      this._actionMessage('保存していない変更があります。先に［保存］してください。', true);
      return;
    }
    if (!confirm('ご自身（' + (RmdState.displayName || 'ログイン中の方') + '）のLINEにテスト送信します。\nよろしいですか？')) return;

    this._setBusy(true, 'test');
    this._actionMessage('');
    try {
      const result = await this._callFunction({
        mode     : 'test',
        store_key: store.store_key,
        member_id: RmdState.memberId
      });
      await this._afterSend(result);
    } catch (err) {
      console.error('[Reminder.sendTest]', err);
      this._actionMessage(err.message, true);
    } finally {
      this._setBusy(false);
    }
  },

  /** 今すぐ送る。タイミングが複数あるときは、どれを送るか選ばせてから確認する */
  sendNow() {
    if (RmdState.busy) return;
    if (!RmdState.period) {
      this._actionMessage('受付中の提出期間がないため、いまは送信できません。', true);
      return;
    }
    if (this._isDirty()) {
      this._actionMessage('保存していない変更があります。先に［保存］してください。', true);
      return;
    }
    const candidates = RmdState.rows.filter(r => r.id && r.is_enabled);
    if (!candidates.length) {
      this._actionMessage('送信できるタイミングがありません。', true);
      return;
    }
    if (candidates.length === 1) {
      this._confirmAndSendNow(candidates[0]);
      return;
    }
    this._openPickModal(candidates);
  },

  _openPickModal(candidates) {
    const modal = document.getElementById('rmd-pick-modal');
    const list  = document.getElementById('rmd-pick-list');
    list.innerHTML = candidates.map((r, i) => {
      const at  = RmdState.period
        ? formatSendAt(calcSendAt(RmdState.period.deadline, r.days_before, r.send_hour, r.send_minute))
        : this._labelOf(DAYS_BEFORE_OPTIONS, r.days_before) + ' ' + pad2(r.send_hour) + ':' + pad2(r.send_minute);
      const who = this._labelOf(TARGET_OPTIONS, r.target);
      return `<button type="button" class="btn-secondary btn-sm" data-pick="${i}">${escapeHtml(at)}（${escapeHtml(who)}）</button>`;
    }).join('');
    list.querySelectorAll('[data-pick]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._closePickModal();
        this._confirmAndSendNow(candidates[Number(btn.dataset.pick)]);
      });
    });
    modal.classList.add('active');
  },

  _closePickModal() {
    document.getElementById('rmd-pick-modal').classList.remove('active');
  },

  /** 人数を明示した確認ダイアログを出してから送る */
  async _confirmAndSendNow(row) {
    const store = this._selectedStore();
    if (!store || !store.store_key) {
      this._actionMessage('店舗情報を取得できませんでした。', true);
      return;
    }
    const pv    = RmdState.preview || {};
    const count = row.target === 'all'
      ? (Number(pv.target_all) || 0)
      : (Number(pv.target_unsubmitted) || 0);
    const who   = row.target === 'all' ? '' : '未提出の';

    if (!confirm(
      store.store_name + 'の' + who + count + '名にLINEを送信します。\n' +
      'よろしいですか？'
    )) return;

    this._setBusy(true, 'now');
    this._actionMessage('');
    try {
      const result = await this._callFunction({
        mode       : 'now',
        store_key  : store.store_key,
        schedule_id: row.id
      });
      await this._afterSend(result);
    } catch (err) {
      console.error('[Reminder._confirmAndSendNow]', err);
      this._actionMessage(err.message, true);
    } finally {
      this._setBusy(false);
    }
  },

  // --------------------------------------------------------
  // 画面の下ごしらえ
  // --------------------------------------------------------

  _setBusy(busy, which) {
    RmdState.busy = busy;
    const labels = { save: '保存中…', test: '送信中…', now: '送信中…' };
    const btns = {
      save: document.getElementById('rmd-save'),
      test: document.getElementById('rmd-test'),
      now : document.getElementById('rmd-now')
    };
    Object.keys(btns).forEach(k => {
      if (!btns[k]) return;
      btns[k].disabled = busy;
    });
    if (busy && which && btns[which]) {
      btns[which].dataset.label = btns[which].textContent;
      btns[which].textContent   = labels[which];
    } else if (!busy) {
      Object.keys(btns).forEach(k => {
        if (btns[k] && btns[k].dataset.label) {
          btns[k].textContent = btns[k].dataset.label;
          delete btns[k].dataset.label;
        }
      });
      // 一律にenabledへ戻さない。受付中の期間が無い店では
      // 送信系は止めたままにする必要がある。
      this._renderActions();
    }
  },

  _actionMessage(message, isError) {
    const box = document.getElementById('rmd-action-msg');
    if (!box) return;
    if (!message) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="${isError ? 'error-banner' : 'warning-banner'}" style="margin-top:12px">`
      + escapeHtml(message) + '</div>';
  },

  /** ボタンのイベントを1度だけ結ぶ */
  bindEvents() {
    document.getElementById('rmd-toggle').addEventListener('click', () => this.toggleEnabled());
    document.getElementById('rmd-add').addEventListener('click', () => this.addRow());
    document.getElementById('rmd-save').addEventListener('click', () => this.save());
    document.getElementById('rmd-test').addEventListener('click', () => this.sendTest());
    document.getElementById('rmd-now').addEventListener('click', () => this.sendNow());
    document.getElementById('rmd-pick-cancel').addEventListener('click', () => this._closePickModal());
    document.getElementById('rmd-pick-modal').addEventListener('click', (e) => {
      if (e.target.id === 'rmd-pick-modal') this._closePickModal();
    });
    document.getElementById('rmd-back').addEventListener('click', () => {
      if (this._isDirty() && !confirm('保存していない変更があります。破棄して戻りますか？')) return;
      location.href = MANAGER_HOME_URL;
    });
  }
};

// ============================================================
// エントリーポイント（manager-home.html と同じ流れ）
// ============================================================

async function initApp() {
  try {
    // 1. LIFF初期化
    await liff.init({ liffId: CONFIG_V2.LIFF_ID });

    // 2. 未ログインならリダイレクト（戻り後に再実行される）
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }

    // 3. Supabaseセッション確立（submit-v2 / manager-home と同じ経路。
    //    IDトークンの期限切れ自動取り直しも SupaAPI 側で効く）
    SupaAPI.init();
    const result = await SupaAPI.login();
    if (result.status === 'need_registration') {
      showScreen('unlinked');
      return;
    }

    // 4. 自分の所属を読み込んで role で分岐
    const me = await SupaAPI.getMe();
    RmdState.userId      = me.profile.id;
    RmdState.displayName = me.profile.display_name;
    RmdState.managed     = me.memberships.filter(
      m => m.role === 'admin' || m.role === 'manager');

    if (!me.memberships.length) {
      showScreen('unlinked');
      return;
    }
    if (!RmdState.managed.length) {
      showScreen('not-manager');
      return;
    }

    RmdState.storeId = RmdState.managed[0].store_id;

    Reminder.bindEvents();
    showScreen('main');
    await Reminder.load();

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
