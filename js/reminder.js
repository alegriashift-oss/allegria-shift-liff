/**
 * アレグリア シフト管理ツール - 提出リマインド（reminder.html 専用）
 *
 * 店長が「いつ・誰に・どんな文面で」LINEを送るかを設定する画面。
 * 画面は3つ構成:
 *   画面A … 予定されているメッセージの一覧
 *   画面B … 作成・編集（削除もここから）
 *   画面C … 配信済み（get_reminder_history を読むだけ）
 *
 * 設計上の約束（既存の動いている仕組みを壊さないための線引き）:
 *   - 認証は api_v2.js の SupaAPI をそのまま使う。ここで独自にトークンを取りに
 *     行かない。IDトークンの期限切れ自動取り直し（_forceRelogin）は SupaAPI 側に
 *     入っているので、SupaAPI.login() を通す限りその恩恵をそのまま受けられる。
 *   - この画面から送信は起動できない。send-reminders は呼ばない。
 *     「自分にテスト送信」「今すぐ送る」は廃止（Edge Function 側でも該当モードを
 *     削除済みで、呼んでも403が返る）。送信ボタンを作らないこと自体が仕様。
 *   - get_reminder_targets は呼ばない（LINE IDを返す運営専用関数。実行権限もない）。
 *   - store_line_credentials は読まない（service_role専用）。
 *   - reminder_logs は直接SELECTしない。配信の記録は get_reminder_history を通す
 *     （何を店長に見せてよいかの線引きは関数側に一本化されている）。
 *   - reminder_settings には書き込まない。配信の開始／停止は運営側の作業で、
 *     店長の画面にトグルは出さない。この画面での is_enabled は読むだけ。
 *   - 行単位の is_enabled（停止中）も店長には触らせない。表示だけ。
 *   - 対象者の判定はフロントでやらない。人数は必ず get_reminder_preview に聞く
 *     （分母の定義＝include_in_submission=true はDB側に一本化されている）。
 *     フロントで数えると店長メニューの提出状況と数字がズレる。
 *   - このページ用の処理はすべてこのファイルに書く。既存JSには一切足さない。
 *
 * ロード順: config_v2.js → api_v2.js → reminder.js
 */

// 店長トップへの戻り先。?v= は manager-home.html 側の現行値に合わせる。
const MANAGER_HOME_URL = 'manager-home.html?v=20260731-v1-reminder';

// LINE無料プランの月間上限200通に対する警告ライン
const QUOTA_LIMIT = 200;
const QUOTA_WARN  = 180;

// 見込み通数から除外する店。テスト店は実配信しないので合計に混ぜない。
const QUOTA_EXCLUDE_STORE_KEYS = ['dummy01'];

// 1か月あたりの提出期間の数。recurring は「毎回の締切ごと」に飛ぶので、
// 月の見込み通数は 1期間ぶん × この値で見積もる。
const PERIODS_PER_MONTH = 2;

// 締切ルールの既定値（store_settings に行が無い店のフォールバック）。
// 前半（1日〜15日）の締切=前月25日 / 後半（16日〜末日）の締切=当月10日。
const DEFAULT_FIRST_HALF_DEADLINE  = 25;
const DEFAULT_SECOND_HALF_DEADLINE = 10;

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

// 配信済み画面に出す件数。並び順（created_at 降順）は関数側で済んでいる。
const HISTORY_LIMIT = 10;

// 配信済みの「どうやって送られたか」。
// manual / test は旧バージョンの記録。いまは作られないが、過去分として表示する。
const HISTORY_KIND_LABELS = {
  scheduled: '自動',
  once     : '今回だけ',
  manual   : '手動',
  test     : 'テスト'
};

// 新規作成時の既定文面
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
  byStore    : {},    // storeId -> { isEnabled, schedules, period, preview, store, settings }
  loaded     : false,
  form       : null,  // 画面Bの編集中データ
  busy       : false  // 保存中の二重実行防止
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

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// JSTはUTC+9で固定（夏時間なし）。この前提を1か所に置く。
const JST_OFFSET_HOURS = 9;

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
 * JSTの暦日 {y,m,d} から daysBefore 日引いて、時刻を当てる。
 * 日付の引き算は UTC の暦日として行う（Date.UTC + getUTC*）ので、
 * 実行端末のタイムゾーンがどこでも同じ結果になる。
 * @returns {{y,m,d,hour,minute}}
 */
function sendAtFromJstDate(p, daysBefore, hour, minute) {
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d));
  base.setUTCDate(base.getUTCDate() - (Number(daysBefore) || 0));
  return {
    y     : base.getUTCFullYear(),
    m     : base.getUTCMonth() + 1,
    d     : base.getUTCDate(),
    hour  : Number(hour) || 0,
    minute: Number(minute) || 0
  };
}

/** 締切（timestamptz）から「送信予定日時（JST）」を求める */
function calcSendAt(deadline, daysBefore, hour, minute) {
  const dl = parseTimestamp(deadline);
  if (!dl) return null;
  return sendAtFromJstDate(toJstDateParts(dl), daysBefore, hour, minute);
}

/** timestamptz → JSTの {y,m,d,hour,minute}（once の send_at 用） */
function jstPartsOf(ts) {
  const d = parseTimestamp(ts);
  if (!d) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  return {
    y     : Number(p.year),
    m     : Number(p.month),
    d     : Number(p.day),
    // 24時をまたぐロケール表記（"24:00"）を 0 に寄せる
    hour  : Number(p.hour) % 24,
    minute: Number(p.minute)
  };
}

/** JSTの暦日 {y,m,d} の曜日（0=日）。端末TZに依存しない。 */
function jstWeekday(p) {
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

/**
 * JSTの「日付＋時刻」を、実際の時刻（epoch ミリ秒）に直す。
 * 端末のタイムゾーンを一切参照しないので、海外にいる店長でも同じ結果になる。
 * @param {string} dateStr 'YYYY-MM-DD'（JSTの暦日）
 */
function jstToEpochMs(dateStr, hour, minute) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  return Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    (Number(hour) || 0) - JST_OFFSET_HOURS, Number(minute) || 0
  );
}

/** 今日のJST日付 'YYYY-MM-DD'（<input type="date"> の min 用） */
function jstTodayIso() {
  const p = toJstDateParts(new Date());
  return p.y + '-' + pad2(p.m) + '-' + pad2(p.d);
}

/** {y,m,d,hour,minute} → "2026/08/10 12:00" */
function formatSendAt(s) {
  if (!s) return '—';
  return s.y + '/' + pad2(s.m) + '/' + pad2(s.d) + ' ' + pad2(s.hour) + ':' + pad2(s.minute);
}

/** {y,m,d,hour,minute} → "8/10 12:00"（削除確認の本文用。年は省く） */
function formatShortSendAt(s) {
  if (!s) return '';
  return s.m + '/' + s.d + ' ' + pad2(s.hour) + ':' + pad2(s.minute);
}

/** {y,m,d,hour,minute} → "2026/08/08(土) 18:00" */
function formatSendAtWithDow(s) {
  if (!s) return '—';
  return s.y + '/' + pad2(s.m) + '/' + pad2(s.d)
    + '(' + WEEKDAYS[jstWeekday(s)] + ') '
    + pad2(s.hour) + ':' + pad2(s.minute);
}

/** timestamptz → "8月10日(月) 23:59"（プレビューの {締切} 用） */
function formatDeadlineJa(ts) {
  const p = jstPartsOf(ts);
  if (!p) return String(ts || '');
  return p.m + '月' + p.d + '日(' + WEEKDAYS[jstWeekday(p)] + ') '
    + pad2(p.hour) + ':' + pad2(p.minute);
}

/** 並べ替え用のキー。求まらないものは末尾に送る。 */
function sendAtKey(s) {
  if (!s) return Number.MAX_SAFE_INTEGER;
  return Date.UTC(s.y, s.m - 1, s.d, s.hour, s.minute);
}

// ============================================================
// 本体
// ============================================================

const Reminder = {

  _selectedStore() {
    return RmdState.managed.find(m => m.store_id === RmdState.storeId) || null;
  },

  _storeOf(storeId) {
    return RmdState.managed.find(m => m.store_id === storeId) || null;
  },

  _data(storeId) {
    return RmdState.byStore[storeId] || null;
  },

  // --------------------------------------------------------
  // 読み込み
  // --------------------------------------------------------

  /**
   * 権限を持つ全店ぶんをまとめて読む。
   * 見込み通数が「全店の合計」なので、表示中の店だけを読んでも足りない。
   * 店舗ごとに往復すると掛け持ち店長で遅くなるため、店IDの配列で一括取得し、
   * 人数のRPCだけ店ごとに呼ぶ。
   */
  async loadAll() {
    const ids = RmdState.managed.map(m => m.store_id);
    const db  = SupaAPI.db;

    // 器を先に用意しておく（部分的に取れなくても描画が落ちないように）
    RmdState.byStore = {};
    ids.forEach(id => {
      RmdState.byStore[id] = {
        isEnabled: false, schedules: [], period: null, preview: null,
        store: null, settings: null
      };
    });

    // 1. 配信の開始状況（行が無い店は「準備中」として扱う。ここでは書き込まない）
    const st = await db.from('reminder_settings')
      .select('store_id, is_enabled')
      .in('store_id', ids);
    if (st.error) throw new Error('リマインド設定の取得に失敗しました: ' + st.error.message);
    (st.data || []).forEach(r => {
      if (RmdState.byStore[r.store_id]) {
        RmdState.byStore[r.store_id].isEnabled = !!r.is_enabled;
      }
    });

    // 2. メッセージ本体
    const sc = await db.from('reminder_schedules')
      .select('id, store_id, schedule_type, days_before, send_hour, send_minute, send_at, sent_at, target, message_template, is_enabled, sort_order')
      .in('store_id', ids)
      .order('sort_order', { ascending: true });
    if (sc.error) throw new Error('メッセージの取得に失敗しました: ' + sc.error.message);
    (sc.data || []).forEach(r => {
      const bucket = RmdState.byStore[r.store_id];
      if (!bucket) return;
      // 1回だけの配信が済んだものは、一覧には出さない（配信済み画面の担当）
      if (r.schedule_type === 'once' && r.sent_at) return;
      bucket.schedules.push(r);
    });

    // 3. 受付中の期間。
    //    並びは deadline の昇順＝送信側 Edge Function と同じ選び方にする。
    //    start_date 順にすると、受付中の期間が一時的に2つ存在したときに
    //    「画面に出ている期間」と「実際に送られる期間」がズレうる。
    const pe = await db.from('shift_periods')
      .select('id, store_id, title, deadline, status')
      .in('store_id', ids)
      .eq('status', 'open')
      .order('deadline', { ascending: true });
    if (pe.error) throw new Error('提出期間の取得に失敗しました: ' + pe.error.message);
    (pe.data || []).forEach(r => {
      const bucket = RmdState.byStore[r.store_id];
      if (!bucket) return;
      if (!bucket.period) bucket.period = r;   // 締切が最も近い1件だけ使う
    });

    // 4. 人数（対象者の定義はDB側。フロントで絞り込まない）。
    //    受付中の期間が無い店は人数を出せないので null のままにする。
    for (const id of ids) {
      const bucket = RmdState.byStore[id];
      if (!bucket.period) continue;
      const pv = await db.rpc('get_reminder_preview', {
        p_store_id : id,
        p_period_id: bucket.period.id
      });
      if (pv.error) throw new Error('対象人数の取得に失敗しました: ' + pv.error.message);
      bucket.preview = Array.isArray(pv.data) ? (pv.data[0] || null) : (pv.data || null);
    }

    // 5. プレビューの {URL} に差し込む提出画面リンク。
    //    ここが取れなくても一覧・編集は使えるようにしたいので、失敗しても止めない
    //    （その場合 {URL} はタグのまま表示し、未設定として注記する）。
    try {
      const so = await db.from('stores')
        .select('id, liff_submit_url')
        .in('id', ids);
      if (so.error) throw new Error(so.error.message);
      (so.data || []).forEach(r => {
        if (RmdState.byStore[r.id]) RmdState.byStore[r.id].store = r;
      });
    } catch (e) {
      console.warn('[Reminder.loadAll] 提出画面リンクを取得できません:', e);
    }

    // 6. 締切ルール（「その次」の推定に使う）。取れなければ既定値（25日／10日）。
    try {
      const ss = await db.from('store_settings')
        .select('store_id, first_half_deadline, second_half_deadline')
        .in('store_id', ids);
      if (ss.error) throw new Error(ss.error.message);
      (ss.data || []).forEach(r => {
        if (RmdState.byStore[r.store_id]) RmdState.byStore[r.store_id].settings = r;
      });
    } catch (e) {
      console.warn('[Reminder.loadAll] 締切ルールを取得できません（既定値を使います）:', e);
    }

    RmdState.loaded = true;
  },

  async switchStore(storeId) {
    if (!RmdState.managed.some(m => m.store_id === storeId)) return;
    if (storeId === RmdState.storeId) return;
    RmdState.storeId = storeId;
    this.render();
  },

  // --------------------------------------------------------
  // 画面A: 描画
  // --------------------------------------------------------

  render() {
    this._renderStoreSwitch();
    this._renderStoreLine();
    this._renderCards();
    this._renderQuota();
  },

  /** 店舗切替タブ（掛け持ち店長のときだけ表示。manager-home と同じ判定） */
  _renderStoreSwitch() {
    const box = document.getElementById('rmd-store-switch');
    if (!box) return;
    if (RmdState.managed.length < 2) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    box.style.display = '';
    box.innerHTML = '<div class="rmd-switch-tabs">' +
      RmdState.managed.map(m => `
        <button type="button" class="rmd-switch-tab${m.store_id === RmdState.storeId ? ' on' : ''}"
          data-store="${escapeHtml(m.store_id)}">${escapeHtml(shortStoreName(m))}</button>
      `).join('') + '</div>';

    box.querySelectorAll('.rmd-switch-tab').forEach(btn => {
      btn.addEventListener('click', () => this.switchStore(btn.dataset.store));
    });
  },

  /**
   * 店名・スタッフ人数と、この店の状態の説明。
   * 準備中（is_enabled=false）の店では「自動で配信されます」と言ってはいけない。
   * 実際には配信されないため、そのまま出すと店長に誤解を与える。
   */
  _renderStoreLine() {
    const store  = this._selectedStore();
    const data   = this._data(RmdState.storeId);
    const line   = document.getElementById('rmd-store-line');
    const lead   = document.getElementById('rmd-store-lead');
    const pend   = document.getElementById('rmd-pending');
    if (!line || !lead || !pend) return;

    const staff = data && data.preview ? Number(data.preview.target_all) : null;
    line.textContent = (store ? store.store_name : '')
      + (staff == null ? '' : ' ・ スタッフ' + staff + '名');

    const enabled = !!(data && data.isEnabled);
    lead.style.display = enabled ? '' : 'none';
    lead.textContent   = enabled ? '下のメッセージが自動で配信されます' : '';
    pend.style.display = enabled ? 'none' : '';
  },

  /** 予定されているメッセージのカード一覧 */
  _renderCards() {
    const box = document.getElementById('rmd-cards');
    if (!box) return;

    const data = this._data(RmdState.storeId);
    if (!data) { box.innerHTML = ''; return; }

    if (!data.schedules.length) {
      box.innerHTML = `
        <div class="rmd-panel">
          <p class="info-text">
            予定されているメッセージはありません。<br>
            下の「メッセージを作成」から追加してください。
          </p>
        </div>`;
      return;
    }

    const pending = !data.isEnabled;

    // 実際に届く順（配信日時の早い順）に並べる。保存順ではない。
    const items = data.schedules
      .map(r => ({ row: r, at: this._sendAtOf(r, data.period) }))
      .sort((a, b) => sendAtKey(a.at) - sendAtKey(b.at));

    box.innerHTML = items.map(it => {
      const r = it.row;

      // 店全体が未開始のときは「準備中」を優先する。
      // 店が動いていない以上、行単位の停止は意味を持たないため併記しない。
      let badges;
      if (pending) {
        badges = '<span class="rmd-badge pending">準備中</span>';
      } else {
        badges = r.schedule_type === 'once'
          ? '<span class="rmd-badge once">今回だけ</span>'
          : '<span class="rmd-badge recurring">毎回くり返す</span>';
        if (r.is_enabled === false) {
          badges += '<span class="rmd-badge paused">停止中</span>';
        }
      }

      const when = it.at
        ? formatSendAt(it.at)
        : '受付中の期間がないため未定';

      return `
        <button type="button" class="rmd-card${pending ? ' pending' : ''}" data-id="${escapeHtml(r.id)}">
          <p class="rmd-card-msg">${escapeHtml(r.message_template || '')}</p>
          <p class="rmd-card-meta">配信先: ${escapeHtml(this._targetLabel(r, data.preview))}</p>
          <p class="rmd-card-meta">配信日時: ${escapeHtml(when)}</p>
          <div class="rmd-card-foot">
            ${badges}
            <span class="rmd-card-chevron" aria-hidden="true">›</span>
          </div>
        </button>`;
    }).join('');

    box.querySelectorAll('.rmd-card').forEach(btn => {
      btn.addEventListener('click', () => this.openEdit(btn.dataset.id));
    });
  },

  /**
   * その行の配信日時。
   *   once      … send_at をそのまま（絶対時刻）
   *   recurring … 受付中の期間の締切から逆算。期間が無ければ求まらない（null）
   */
  _sendAtOf(row, period) {
    if (row.schedule_type === 'once') return jstPartsOf(row.send_at);
    if (!period) return null;
    return calcSendAt(period.deadline, row.days_before, row.send_hour, row.send_minute);
  },

  /** 「全員（18名）」「未提出の人だけ（現在3名）」 */
  _targetLabel(row, preview) {
    if (row.target === 'unsubmitted') {
      const n = preview ? Number(preview.target_unsubmitted) : null;
      return '未提出の人だけ' + (n == null ? '' : '（現在' + n + '名）');
    }
    const n = preview ? Number(preview.target_all) : null;
    return '全員' + (n == null ? '' : '（' + n + '名）');
  },

  /** その行が1回の配信で使う通数 */
  _recipientsOf(row, preview) {
    if (!preview) return 0;
    return row.target === 'unsubmitted'
      ? (Number(preview.target_unsubmitted) || 0)
      : (Number(preview.target_all) || 0);
  },

  /**
   * 今月の見込み通数。権限を持つ全店の合計（テスト店は除く）。
   *   recurring … 1期間ぶん × 月の期間数
   *   once      … 今月中に配信予定のものだけ1通ぶん
   * 停止中の行と、配信済みの once は数えない。
   */
  _renderQuota() {
    const panel = document.getElementById('rmd-quota-panel');
    const box   = document.getElementById('rmd-quota');
    if (!panel || !box) return;

    const targets = RmdState.managed.filter(
      m => !QUOTA_EXCLUDE_STORE_KEYS.includes(m.store_key));
    if (!targets.length) {
      panel.style.display = 'none';
      return;
    }

    const now = toJstDateParts(new Date());
    let total = 0;

    targets.forEach(m => {
      const data = this._data(m.store_id);
      if (!data) return;
      data.schedules.forEach(r => {
        if (r.is_enabled === false) return;
        const n = this._recipientsOf(r, data.preview);
        if (r.schedule_type === 'once') {
          const at = jstPartsOf(r.send_at);
          if (at && at.y === now.y && at.m === now.m) total += n;
        } else {
          total += n * PERIODS_PER_MONTH;
        }
      });
    });

    const warn  = total > QUOTA_WARN;
    const names = targets.map(m => shortStoreName(m)).join('・');

    panel.style.display = '';
    box.className   = 'rmd-quota' + (warn ? ' warn' : '');
    box.innerHTML   = `今月の見込み ${total}通 / ${QUOTA_LIMIT}通
      <div class="rmd-quota-sub">（${escapeHtml(names)}の合計）</div>`
      + (warn
          ? `<div class="rmd-quota-sub">⚠️ LINE無料プランの上限（月${QUOTA_LIMIT}通）に近づいています。</div>`
          : '');
  },

  // --------------------------------------------------------
  // 画面B: 作成・編集
  // --------------------------------------------------------

  /**
   * 画面Bを開く。idが無ければ新規作成。
   * 編集時は配信のしかた（recurring / once）を変更させない。
   * recurring ⇄ once の変換は send_at / sent_at の制約が絡んで複雑なので、
   * 変えたいときは削除して作り直す運用にする。
   */
  openEdit(scheduleId) {
    const storeId = RmdState.storeId;
    const data    = this._data(storeId);
    const row     = scheduleId && data
      ? data.schedules.find(r => r.id === scheduleId) : null;

    if (scheduleId && !row) {
      showToast('メッセージが見つかりませんでした');
      return;
    }

    if (row) {
      const once = row.schedule_type === 'once';
      const at   = once ? jstPartsOf(row.send_at) : null;
      RmdState.form = {
        id          : row.id,
        storeId     : storeId,
        isNew       : false,
        scheduleType: once ? 'once' : 'recurring',
        daysBefore  : Number(row.days_before) || 0,
        hour        : once ? (at ? at.hour : 12) : (Number(row.send_hour) || 0),
        // 分は画面から選べない（00分のみ）。既存行が持っている値は勝手に変えない。
        minute      : once ? (at ? at.minute : 0) : (Number(row.send_minute) || 0),
        dateStr     : at ? (at.y + '-' + pad2(at.m) + '-' + pad2(at.d)) : '',
        target      : row.target === 'unsubmitted' ? 'unsubmitted' : 'all',
        message     : row.message_template || '',
        sortOrder   : Number(row.sort_order) || 0
      };
    } else {
      const maxSort = (data && data.schedules.length)
        ? Math.max.apply(null, data.schedules.map(r => Number(r.sort_order) || 0))
        : -1;
      RmdState.form = {
        id          : null,
        storeId     : storeId,
        isNew       : true,
        scheduleType: 'recurring',
        daysBefore  : 0,
        hour        : 12,
        minute      : 0,
        dateStr     : '',
        target      : 'all',
        message     : DEFAULT_TEMPLATE,
        sortOrder   : maxSort + 1
      };
    }

    this._editMessage('');
    this._renderEdit();
    showScreen('edit');
  },

  _renderEdit() {
    const form  = RmdState.form;
    if (!form) return;
    const store = this._storeOf(form.storeId);

    const title = document.getElementById('rmd-edit-title');
    if (title) title.textContent = form.isNew ? 'メッセージを作成' : 'メッセージを編集';
    const sub = document.getElementById('rmd-edit-store');
    if (sub) sub.textContent = store ? store.store_name : '';

    // 配信のしかた。編集中は変更させない。
    document.querySelectorAll('#rmd-kind .rmd-seg-btn').forEach(btn => {
      btn.classList.toggle('on', btn.dataset.kind === form.scheduleType);
      btn.disabled = !form.isNew;
    });
    const kindNote = document.getElementById('rmd-kind-note');
    if (kindNote) kindNote.style.display = form.isNew ? 'none' : '';

    this._renderWhenFields();
    this._renderWhenBox();

    const target = document.getElementById('rmd-target');
    if (target) target.value = form.target;
    this._renderTargetNote();

    const msg = document.getElementById('rmd-msg');
    if (msg) {
      msg.value = form.message;
      msg.classList.remove('input-error');
    }
    this._renderPreview();

    // 削除できるのは保存済みのメッセージだけ。新規作成中は出さない。
    const del = document.getElementById('rmd-delete');
    if (del) {
      del.disabled      = false;
      del.style.display = form.isNew ? 'none' : '';
    }
  },

  /** 配信日時の入力欄（しかたによって出し分ける） */
  _renderWhenFields() {
    const form = RmdState.form;
    const once = form.scheduleType === 'once';

    const recBox  = document.getElementById('rmd-when-recurring');
    const onceBox = document.getElementById('rmd-when-once');
    if (recBox)  recBox.style.display  = once ? 'none' : '';
    if (onceBox) onceBox.style.display = once ? '' : 'none';

    const days = document.getElementById('rmd-days');
    if (days) {
      days.innerHTML = this._options(DAYS_BEFORE_OPTIONS, form.daysBefore);
    }

    const hourOpts = this._hourOptions(form.hour, form.minute);
    ['rmd-hour', 'rmd-hour-once'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = this._options(hourOpts, form.hour);
    });

    const date = document.getElementById('rmd-date');
    if (date) {
      date.value = form.dateStr || '';
      // 過去日は選ばせない（保存時にも弾くが、入口で気づけるほうがよい）
      date.min = jstTodayIso();
    }
  },

  /** <option> を組み立てる（selected付き） */
  _options(options, current) {
    return options.map(o =>
      `<option value="${escapeHtml(o.value)}"${String(o.value) === String(current) ? ' selected' : ''}>`
      + escapeHtml(o.label) + '</option>'
    ).join('');
  },

  /**
   * 時刻の選択肢。00分のみ（:30 は出さない方針）。
   * ただし既存行が一覧に無い時刻・分を持っている場合は、その値を黙って
   * 書き換えてしまわないよう、その1つだけ選択肢に足す。
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

  /**
   * 配信日時の説明ボックス。
   * 「いつ届くのか」を日時そのもので見せる。相対表現だけだと店長が確認できない。
   */
  _renderWhenBox() {
    const box  = document.getElementById('rmd-when-box');
    if (!box) return;
    const form = RmdState.form;
    const data = this._data(form.storeId);

    if (form.scheduleType === 'once') {
      if (!form.dateStr) {
        box.className = 'rmd-when-box muted';
        box.textContent = '配信日を選んでください。';
        return;
      }
      const at = {
        y: Number(form.dateStr.slice(0, 4)),
        m: Number(form.dateStr.slice(5, 7)),
        d: Number(form.dateStr.slice(8, 10)),
        hour: form.hour, minute: form.minute
      };
      box.className = 'rmd-when-box once';
      box.innerHTML = escapeHtml(formatSendAtWithDow(at)) + ' に1回だけ<br>'
        + '配信が終わると一覧から消えます';
      return;
    }

    // 毎回くり返す
    if (!data || !data.period) {
      box.className = 'rmd-when-box muted';
      box.textContent = '受付中の提出期間がないため、次回の配信日時はまだ決まりません。'
        + '期間が開くと自動で決まります。';
      return;
    }

    const first  = calcSendAt(data.period.deadline, form.daysBefore, form.hour, form.minute);
    const nextDl = this._estimateNextDeadline(data);
    const second = nextDl ? sendAtFromJstDate(nextDl, form.daysBefore, form.hour, form.minute) : null;

    box.className = 'rmd-when-box recurring';
    box.innerHTML = '次回 ' + escapeHtml(formatSendAt(first)) + '<br>'
      + (second ? 'その次 ' + escapeHtml(formatSendAt(second)) + '<br>' : '')
      + '以降もずっと続きます';
  },

  /**
   * 次の期間の締切を推定する（「その次」の表示に使う目安）。
   * 締切は「前半＝前月25日 / 後半＝当月10日」で交互に来るので、
   *   10日締切 → 同じ月の25日
   *   25日締切 → 翌月の10日
   * 日付がどちらにも当てはまらない店（不規則な締切）は推定しない。
   * @returns {{y,m,d}|null}
   */
  _estimateNextDeadline(data) {
    const p = jstPartsOf(data.period.deadline);
    if (!p) return null;
    const s      = data.settings || {};
    const first  = Number(s.first_half_deadline)  || DEFAULT_FIRST_HALF_DEADLINE;
    const second = Number(s.second_half_deadline) || DEFAULT_SECOND_HALF_DEADLINE;

    if (p.d === second) return { y: p.y, m: p.m, d: first };
    if (p.d === first) {
      return p.m === 12
        ? { y: p.y + 1, m: 1,       d: second }
        : { y: p.y,     m: p.m + 1, d: second };
    }
    return null;
  },

  /** 「いま18名に届きます」 */
  _renderTargetNote() {
    const note = document.getElementById('rmd-target-note');
    if (!note) return;
    const form = RmdState.form;
    const data = this._data(form.storeId);
    const pv   = data ? data.preview : null;

    if (!pv) {
      note.textContent = '受付中の提出期間がないため、いまの人数は表示できません。';
      return;
    }
    const n = form.target === 'unsubmitted'
      ? (Number(pv.target_unsubmitted) || 0)
      : (Number(pv.target_all) || 0);
    note.textContent = 'いま' + n + '名に届きます';
  },

  /**
   * プレビュー。タグを実際の値に差し替えて、届く姿をそのまま見せる。
   * 差し替えられない値（期間が無い・リンク未設定）はタグのまま残し、
   * 何が足りないかを下に注記する。勝手に埋めると嘘になる。
   */
  _renderPreview() {
    const box  = document.getElementById('rmd-preview');
    const note = document.getElementById('rmd-preview-note');
    if (!box) return;

    const form   = RmdState.form;
    const data   = this._data(form.storeId);
    const period = data ? data.period : null;
    const url    = data && data.store ? data.store.liff_submit_url : null;

    let text = String(form.message || '');
    text = text.split('{名前}').join(RmdState.displayName || 'お名前');
    if (period) {
      text = text.split('{期間}').join(period.title || '');
      text = text.split('{締切}').join(formatDeadlineJa(period.deadline));
    }
    if (url) text = text.split('{URL}').join(url);

    let html = escapeHtml(text);
    if (url) {
      // URLだけリンク色にする。実際にタップできる必要はないので <a> にはしない。
      const escUrl = escapeHtml(url);
      html = html.split(escUrl).join('<span class="rmd-pv-url">' + escUrl + '</span>');
    }
    box.innerHTML = html || '<span style="color:#9ca3af">（メッセージが空です）</span>';

    if (note) {
      const reasons = [];
      if (!url)    reasons.push('提出画面のリンクが未設定です。{URL} はこのまま送られます。');
      if (!period) reasons.push('受付中の提出期間がないため、{期間} と {締切} は差し替えできません。');
      note.style.display = reasons.length ? '' : 'none';
      note.textContent   = reasons.join(' ');
    }
  },

  // --------------------------------------------------------
  // 画面B: 保存
  // --------------------------------------------------------

  /**
   * 保存。
   * DBの形の制約（reminder_schedules_shape_chk）に合わせて、
   *   recurring … send_at / sent_at は送らない（NULLのまま）
   *   once      … send_at は必須
   * を厳密に守る。id は保持したまま更新する（全削除→全挿入はしない）。
   * reminder_logs.schedule_id からの参照を切らないため。
   */
  async save() {
    if (RmdState.busy) return;
    const form = RmdState.form;
    if (!form) return;

    const data    = this._data(form.storeId);
    const message = String(form.message || '').trim();

    if (!message) {
      this._editMessage('メッセージが空です。文面を入力してください。', true);
      const el = document.getElementById('rmd-msg');
      if (el) { el.classList.add('input-error'); el.focus(); }
      return;
    }

    let sendAtIso = null;

    if (form.scheduleType === 'once') {
      if (!form.dateStr) {
        this._editMessage('配信日を選んでください。', true);
        return;
      }
      const ms = jstToEpochMs(form.dateStr, form.hour, form.minute);
      if (ms == null) {
        this._editMessage('配信日を正しく選んでください。', true);
        return;
      }
      if (ms <= Date.now()) {
        this._editMessage('過去の日時は指定できません。', true);
        return;
      }
      // JSTの日付＋時刻をUTCのtimestamptzに変換して保存（端末TZ非依存）
      sendAtIso = new Date(ms).toISOString();

    } else {
      // 同じタイミングの重複はDBのunique制約に当たる。手前で気づかせる。
      const dup = (data ? data.schedules : []).some(r =>
        r.schedule_type !== 'once'
        && r.id !== form.id
        && Number(r.days_before) === Number(form.daysBefore)
        && Number(r.send_hour)   === Number(form.hour)
        && Number(r.send_minute) === Number(form.minute));
      if (dup) {
        this._editMessage('同じタイミングがすでにあります。日にちか時刻を変えてください。', true);
        return;
      }
    }

    // 送る列を、配信のしかたごとに厳密に組み立てる。
    // is_enabled と sent_at は画面から触らせない（運営側の管理項目）。
    const payload = {
      target          : form.target,
      message_template: message
    };
    if (form.scheduleType === 'once') {
      payload.send_at = sendAtIso;
    } else {
      payload.days_before = Number(form.daysBefore);
      payload.send_hour   = Number(form.hour);
      payload.send_minute = Number(form.minute);
    }

    this._setBusy(true, 'save');
    this._editMessage('');

    try {
      const db = SupaAPI.db;
      let res;

      if (form.isNew) {
        res = await db.from('reminder_schedules').insert(Object.assign({
          store_id     : form.storeId,
          schedule_type: form.scheduleType,
          sort_order   : Number(form.sortOrder) || 0
        }, payload));
      } else {
        // schedule_type は送らない（作成後は変更できない仕様）
        res = await db.from('reminder_schedules')
          .update(payload)
          .eq('id', form.id)
          .eq('store_id', form.storeId);
      }
      if (res.error) throw res.error;

      showToast('保存しました');
      await this.loadAll();
      this.render();
      showScreen('list');

    } catch (err) {
      console.error('[Reminder.save]', err);
      this._editMessage(this._saveErrorMessage(err), true);
    } finally {
      this._setBusy(false);
    }
  },

  /**
   * DBのエラーを店長が読める文言にする。
   * 生のメッセージ（duplicate key value violates…）は読めないので、
   * 何をすれば直るかだけを伝える。
   */
  _saveErrorMessage(err) {
    const code = err && err.code;
    if (code === '23505') {
      return '同じタイミングがすでにあります。日にちか時刻を変えてください。';
    }
    if (code === '23514') {
      return '配信のしかたと配信日時の組み合わせが正しくありません。'
        + '入力内容をご確認ください。';
    }
    return '保存に失敗しました: ' + ((err && err.message) || '');
  },

  /** @param {string} which 'save' | 'delete'。ラベルを変えるのは押した側だけ */
  _setBusy(busy, which) {
    RmdState.busy = busy;
    const save = document.getElementById('rmd-save');
    if (save) {
      save.disabled    = busy;
      save.textContent = (busy && which === 'save') ? '保存中…' : '保存';
    }
    const del = document.getElementById('rmd-delete');
    if (del) del.disabled = busy;
  },

  _editMessage(message, isError) {
    const box = document.getElementById('rmd-edit-msg');
    if (!box) return;
    if (!message) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="${isError ? 'error-banner' : 'warning-banner'}">`
      + escapeHtml(message) + '</div>';
  },

  // --------------------------------------------------------
  // 画面B: 削除
  // --------------------------------------------------------

  /**
   * 削除の確認。confirm() は使わない。
   * 何を消すのか（文面）と、消すと何が起きるのか（いつから届かなくなるか）を
   * 見せてから決めてもらう。ボタンだけの確認では判断材料が無い。
   */
  openDeleteModal() {
    const form = RmdState.form;
    if (!form || form.isNew || RmdState.busy) return;

    const data = this._data(form.storeId);
    const row  = data ? data.schedules.find(r => r.id === form.id) : null;

    const excerpt = document.getElementById('rmd-del-excerpt');
    if (excerpt) excerpt.textContent = String(form.message || '').trim();

    // 「いつから届かなくなるか」＝この行の次の配信日時
    const at = row ? this._sendAtOf(row, data.period) : null;
    const effect = document.getElementById('rmd-del-effect');
    if (effect) {
      effect.textContent = at
        ? '削除すると、' + formatShortSendAt(at) + ' 以降このメッセージは配信されなくなります'
        : '削除すると、このメッセージは配信されなくなります';
    }

    document.getElementById('rmd-del-modal').classList.add('active');
  },

  closeDeleteModal() {
    document.getElementById('rmd-del-modal').classList.remove('active');
  },

  async confirmDelete() {
    if (RmdState.busy) return;
    const form = RmdState.form;
    if (!form || form.isNew) return;

    this._setBusy(true, 'delete');
    const okBtn = document.getElementById('rmd-del-ok');
    if (okBtn) { okBtn.disabled = true; okBtn.textContent = '削除中…'; }

    try {
      const res = await SupaAPI.db.from('reminder_schedules')
        .delete()
        .eq('id', form.id)
        .eq('store_id', form.storeId);
      if (res.error) throw res.error;

      this.closeDeleteModal();
      RmdState.form = null;
      showToast('削除しました');
      await this.loadAll();
      this.render();
      showScreen('list');

    } catch (err) {
      console.error('[Reminder.confirmDelete]', err);
      this.closeDeleteModal();
      this._editMessage('削除に失敗しました: ' + ((err && err.message) || ''), true);
    } finally {
      if (okBtn) { okBtn.disabled = false; okBtn.textContent = '削除する'; }
      this._setBusy(false);
    }
  },

  // --------------------------------------------------------
  // 画面C: 配信済み
  // --------------------------------------------------------

  /**
   * 配信済み画面へ。
   * データは get_reminder_history に聞く。reminder_logs は直接SELECTしない
   * （何を店長に見せてよいかの線引きは関数側に一本化されている）。
   */
  async openSent() {
    const storeId = RmdState.storeId;
    const store   = this._storeOf(storeId);

    const sub = document.getElementById('rmd-sent-store');
    if (sub) sub.textContent = store ? store.store_name : '';

    const box = document.getElementById('rmd-sent-list');
    if (box) box.innerHTML = '<p class="loading-text">読み込み中…</p>';
    showScreen('sent');

    try {
      const res = await SupaAPI.db.rpc('get_reminder_history', {
        p_store_id: storeId,
        p_limit   : HISTORY_LIMIT
      });
      if (res.error) throw new Error(res.error.message);
      // 表示中に店を切り替えられた場合は、古い結果を描かない
      if (RmdState.storeId !== storeId) return;
      this._renderHistory(Array.isArray(res.data) ? res.data : []);

    } catch (err) {
      console.error('[Reminder.openSent]', err);
      if (box) {
        box.innerHTML = `<div class="rmd-panel"><p class="error-text">`
          + escapeHtml('配信の記録を取得できませんでした: ' + err.message)
          + '</p></div>';
      }
    }
  },

  _renderHistory(rows) {
    const box = document.getElementById('rmd-sent-list');
    if (!box) return;

    if (!rows.length) {
      box.innerHTML = '<div class="rmd-panel"><p class="info-text">まだ配信の記録はありません。</p></div>';
      return;
    }

    box.innerHTML = rows.map(r => {
      // 送り終わっていれば sent_at、まだなら created_at
      const when = formatSendAt(jstPartsOf(r.sent_at || r.created_at));
      const kind = HISTORY_KIND_LABELS[r.kind] || r.kind || '';
      const to   = r.target === 'unsubmitted' ? '未提出の人だけ'
                 : r.target === 'all'         ? '全員' : '';

      return `
        <div class="rmd-hist">
          <p class="rmd-hist-msg">${escapeHtml(r.message_excerpt || '')}</p>
          ${to ? `<p class="rmd-hist-meta">配信先: ${escapeHtml(to)}</p>` : ''}
          <p class="rmd-hist-meta">配信日時: ${escapeHtml(when)}</p>
          <div class="rmd-hist-foot">
            ${this._historyBadge(r)}
            ${kind ? `<span class="rmd-hist-kind">${escapeHtml(kind)}</span>` : ''}
          </div>
        </div>`;
    }).join('');
  },

  /**
   * 配信結果のバッジ。
   * failed の詳細（error本文）は出さない。生のエラー文は店長には読めないし、
   * get_reminder_history もその列を返さない。
   */
  _historyBadge(row) {
    const status = row.status;
    if (status === 'sent') {
      const n = row.recipient_count == null ? null : Number(row.recipient_count);
      return '<span class="rmd-hist-badge sent">✓ '
        + (n == null ? '配信しました' : n + '名に配信') + '</span>';
    }
    if (status === 'no_target') {
      return '<span class="rmd-hist-badge no_target">全員提出済みのため配信なし</span>';
    }
    if (status === 'failed') {
      return '<span class="rmd-hist-badge failed">配信できませんでした</span>';
    }
    if (status === 'sending') {
      return '<span class="rmd-hist-badge sending">配信中</span>';
    }
    return `<span class="rmd-hist-badge sending">${escapeHtml(status || '')}</span>`;
  },

  // --------------------------------------------------------
  // 画面遷移
  // --------------------------------------------------------


  backToList() {
    RmdState.form = null;
    showScreen('list');
  },

  backToManagerHome() {
    location.href = MANAGER_HOME_URL;
  },

  /** ボタンのイベントを1度だけ結ぶ */
  bindEvents() {
    // --- 画面A ---
    document.getElementById('rmd-create').addEventListener('click', () => this.openEdit(null));
    document.getElementById('rmd-sent').addEventListener('click', () => this.openSent());
    document.getElementById('rmd-back').addEventListener('click', () => this.backToManagerHome());
    document.getElementById('rmd-back-top').addEventListener('click', () => this.backToManagerHome());

    // --- 画面B ---
    document.querySelectorAll('#rmd-kind .rmd-seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const form = RmdState.form;
        if (!form || !form.isNew) return;      // 編集中は変更できない
        if (form.scheduleType === btn.dataset.kind) return;
        form.scheduleType = btn.dataset.kind;
        this._renderEdit();
      });
    });

    document.getElementById('rmd-days').addEventListener('change', (e) => {
      RmdState.form.daysBefore = Number(e.target.value);
      this._renderWhenBox();
    });

    ['rmd-hour', 'rmd-hour-once'].forEach(id => {
      document.getElementById(id).addEventListener('change', (e) => {
        RmdState.form.hour   = Number(e.target.value);
        RmdState.form.minute = 0;   // 画面から選べるのは00分のみ
        this._renderWhenFields();   // 片方を変えたらもう片方の表示も合わせる
        this._renderWhenBox();
      });
    });

    document.getElementById('rmd-date').addEventListener('change', (e) => {
      RmdState.form.dateStr = e.target.value || '';
      this._renderWhenBox();
    });

    document.getElementById('rmd-target').addEventListener('change', (e) => {
      RmdState.form.target = e.target.value === 'unsubmitted' ? 'unsubmitted' : 'all';
      this._renderTargetNote();
    });

    const msg = document.getElementById('rmd-msg');
    msg.addEventListener('input', (e) => {
      RmdState.form.message = e.target.value;
      e.target.classList.remove('input-error');
      this._renderPreview();
    });

    document.getElementById('rmd-save').addEventListener('click', () => this.save());
    document.getElementById('rmd-delete').addEventListener('click', () => this.openDeleteModal());
    document.getElementById('rmd-edit-back').addEventListener('click', () => this.backToList());
    document.getElementById('rmd-edit-back2').addEventListener('click', () => this.backToList());

    // --- 削除の確認モーダル ---
    document.getElementById('rmd-del-cancel').addEventListener('click', () => this.closeDeleteModal());
    document.getElementById('rmd-del-ok').addEventListener('click', () => this.confirmDelete());
    document.getElementById('rmd-del-modal').addEventListener('click', (e) => {
      // 背景を触ったときだけ閉じる（ボックス内のタップで閉じない）
      if (e.target.id === 'rmd-del-modal') this.closeDeleteModal();
    });

    // --- 画面C ---
    document.getElementById('rmd-sent-back').addEventListener('click', () => this.backToList());
    document.getElementById('rmd-sent-back2').addEventListener('click', () => this.backToList());
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
    await Reminder.loadAll();
    Reminder.render();
    showScreen('list');

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
