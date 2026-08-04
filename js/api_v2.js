/**
 * アレグリア シフト管理ツール - Supabase通信モジュール（v2）
 *
 * GAS版 api.js の置き換え。認証は line-auth Edge Function、
 * データ読み書きは supabase-js 経由（RLSが効く）。
 *
 * 認証フロー:
 *   1. supabase.auth.getSession() で有効セッションがあればそれを使う
 *   2. なければ liff.getIDToken() → line-auth(login)
 *      - status: "ok"               → verifyOtp(token_hash) でセッション確立
 *      - status: "need_registration" → 候補から名前を選んで register
 */
const SupaAPI = {

  db: null,
  user: null,

  init() {
    if (!this.db) {
      // supabase はCDNのグローバル（@supabase/supabase-js v2）
      this.db = supabase.createClient(CONFIG_V2.SUPABASE_URL, CONFIG_V2.SUPABASE_ANON_KEY);
    }
  },

  // ============================================================
  // 認証
  // ============================================================

  async _callLineAuth(payload) {
    const res = await fetch(CONFIG_V2.LINE_AUTH_URL, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(payload)
    });
    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw new Error('認証サーバーの応答を解析できませんでした (HTTP ' + res.status + ')');
    }
    return { http: res.status, body: body };
  },

  /**
   * JWT（LINEのIDトークン）の exp をミリ秒で返す。判定できなければ 0。
   * 署名検証はしない＝「期限が近いか」を手前で見るためだけの用途。
   * 検証はあくまで line-auth Edge Function 側の責務。
   */
  _decodeJwtExpMs(jwt) {
    try {
      const seg = String(jwt).split('.')[1];
      if (!seg) return 0;
      // base64url → base64（パディングを補う）
      let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      // payload に日本語が入っていてもよいよう UTF-8 として解く
      const json = decodeURIComponent(
        atob(b64).split('').map(
          c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
        ).join('')
      );
      const exp = JSON.parse(json).exp;
      return typeof exp === 'number' ? exp * 1000 : 0;
    } catch (e) {
      return 0;
    }
  },

  /**
   * IDトークンの期限切れを検知したときの自動復旧。
   *
   * liff.logout() → liff.login() でトークンを取り直す。リダイレクトで戻ってくるので、
   * 呼び出し側は以降の処理を止める必要がある＝ここでは必ず throw して流れを断ち切る。
   *
   * sessionStorage のフラグで「1セッションにつき自動リトライは1回だけ」に制限する。
   * 取り直してもなお期限切れなら、リロードのたびに再ログインを繰り返す無限ループに
   * なるため（今回の不具合の本体）、そこで打ち切って手動対処を案内する。
   * フラグは _establishSession() の成功時に消す。
   */
  _forceRelogin() {
    if (sessionStorage.getItem('wolshif_relogin') === '1') {
      throw new Error(
        'LINEの認証情報の有効期限が切れました。お手数ですが、LINEアプリを一度完全に終了してから、もう一度開いてください。'
      );
    }
    sessionStorage.setItem('wolshif_relogin', '1');
    try { liff.logout(); } catch (e) {}
    liff.login({ redirectUri: location.href });
    // 画面遷移が始まるまでの間に古いトークンで処理が進まないよう、ここで止める
    throw new Error('LINEの認証情報を更新しています。この画面のままお待ちください…');
  },

  _getIdTokenOrThrow() {
    const idToken = liff.getIDToken();
    if (!idToken) {
      throw new Error('LINE認証情報を取得できませんでした。LINEアプリ内で開き直してください。');
    }
    // 期限切れ（や切れる直前）のトークンを投げても401になるだけなので、手前で取り直す。
    // exp が読めなかった場合(0)は判定不能としてそのまま送り、サーバー側の判断に委ねる。
    const expMs = this._decodeJwtExpMs(idToken);
    if (expMs && (expMs - Date.now()) < 60 * 1000) {
      this._forceRelogin();  // 必ず throw する
    }
    return idToken;
  },

  /**
   * ログイン。セッション確立まで終わると status:'ok' を返す。
   * 未連携のときは status:'need_registration' と candidates を返す。
   */
  async login() {
    const { data: { session } } = await this.db.auth.getSession();
    if (session) {
      this.user = session.user;
      return { status: 'ok' };
    }

    const { http, body } = await this._callLineAuth({
      action : 'login',
      idToken: this._getIdTokenOrThrow()
    });

    if (body.status === 'ok') {
      await this._establishSession(body);
      return { status: 'ok' };
    }
    if (body.status === 'need_registration') {
      return body;
    }
    // 端末時計のズレ等で手前の期限チェックをすり抜けた期限切れは、ここで拾って取り直す
    if (this._isExpiredTokenResponse(http, body)) {
      this._forceRelogin();  // 必ず throw する
    }
    throw new Error('ログインに失敗しました (HTTP ' + http + '): ' + (body.message || body.code || ''));
  },

  /**
   * 初回登録。成功すると status:'ok'（セッション確立済み）。
   * 名前が取られていたときは status:'error', code:'name_already_taken' をそのまま返す。
   */
  async register(profileId) {
    const { http, body } = await this._callLineAuth({
      action   : 'register',
      idToken  : this._getIdTokenOrThrow(),
      profileId: profileId
    });

    if (body.status === 'ok') {
      await this._establishSession(body);
      return { status: 'ok' };
    }
    if (http === 409 && body.code === 'name_already_taken') {
      return body;
    }
    if (this._isExpiredTokenResponse(http, body)) {
      this._forceRelogin();  // 必ず throw する
    }
    throw new Error('登録に失敗しました (HTTP ' + http + '): ' + (body.message || body.code || ''));
  },

  /**
   * line-auth の応答が「IDトークンの期限切れ」かどうか。
   * 本文の形（message / code / error のどこに入るか）に依存しないよう、
   * 401 かつ本文のどこかに expired を含むか、で判定する。
   */
  _isExpiredTokenResponse(http, body) {
    if (http !== 401) return false;
    try {
      return /expired/i.test(JSON.stringify(body || {}));
    } catch (e) {
      return false;
    }
  },

  async _establishSession(authResult) {
    const { data, error } = await this.db.auth.verifyOtp({
      type      : 'magiclink',
      token_hash: authResult.token_hash
    });
    if (error) {
      throw new Error('セッションの確立に失敗しました: ' + error.message);
    }
    this.user = data.user;
    // 正常にログインできた＝自動リトライ枠を次回のためにリセットする
    sessionStorage.removeItem('wolshif_relogin');
  },

  // ============================================================
  // 自分の情報
  // ============================================================

  /**
   * 自分のプロフィールと所属（店舗名つき）を取得
   * RLSは同僚の行も返しうるので、必ず自分のIDで絞り込む。
   * @returns {Promise<{profile:{id,display_name}, memberships:Array<{store_id,store_name,role,member_code,status}>}>}
   */
  async getMe() {
    const uid = this.user.id;

    const prof = await this.db.from('profiles')
      .select('id, display_name')
      .eq('id', uid);
    if (prof.error) throw new Error('プロフィールの取得に失敗しました: ' + prof.error.message);
    const profile = (prof.data || [])[0];
    if (!profile) throw new Error('プロフィールが見つかりませんでした');

    const mem = await this.db.from('store_members')
      .select('store_id, role, member_code, status')
      .eq('user_id', uid)
      .eq('status', 'active');
    if (mem.error) throw new Error('所属情報の取得に失敗しました: ' + mem.error.message);
    const memberships = mem.data || [];

    const storeInfo = {};
    if (memberships.length) {
      // spreadsheet_id / sheet_gid は manager-home の「スプレッドシートを開く」ボタン用。
      // store_key は admin-v2 の手動シート更新FAB（GASが store_key で店を突合）用。
      // submit-v2 では未使用（無害な追加列）。
      const st = await this.db.from('stores')
        .select('id, name, store_key, spreadsheet_id, sheet_gid')
        .in('id', memberships.map(m => m.store_id));
      if (st.error) throw new Error('店舗情報の取得に失敗しました: ' + st.error.message);
      (st.data || []).forEach(s => { storeInfo[s.id] = s; });
    }
    memberships.forEach(m => {
      const info = storeInfo[m.store_id] || null;
      m.store_name     = info ? (info.name || '') : '';
      m.store_key      = info ? info.store_key : null;
      m.spreadsheet_id = info ? info.spreadsheet_id : null;
      m.sheet_gid      = info ? info.sheet_gid : null;
    });

    return { profile: profile, memberships: memberships };
  },

  /**
   * 店舗の公式アカウント友だち追加URL（stores.line_add_friend_url）を取得する。
   * manager-home の「新メンバーに案内を送る」を押したときだけ引く。
   * ※ getMe() の select には足さない: 列が解決できないと PostgREST は select 全体を
   *   失敗させるため、submit-v2 を含む全ページのログインが道連れになる。
   *   失敗をこの導線の中だけに閉じ込める。
   * @param {string} storeId 表示中の店舗ID
   * @returns {Promise<string|null>} 未登録・空文字なら null
   */
  async getStoreAddFriendUrl(storeId) {
    const res = await this.db.from('stores')
      .select('line_add_friend_url')
      .eq('id', storeId)
      .limit(1);
    if (res.error) throw new Error('友だち追加URLの取得に失敗しました: ' + res.error.message);
    const row = (res.data || [])[0];
    const url = row ? String(row.line_add_friend_url || '').trim() : '';
    return url !== '' ? url : null;
  },

  /**
   * GASに手動シート同期を依頼する（admin-v2 のメンバー管理FABから呼ぶ）。
   * 普段の10分同期と同じ runSupabaseSyncNow() をGAS側で1回走らせる。
   * Content-Type を付けない＝text/plain扱いでCORSプリフライトを回避し、
   * GAS側は e.postData.contents を素直に JSON.parse する。
   * @param {string} storeKey 現在表示中の店舗の store_key
   * @returns {Promise<{status:string, skipped?:boolean, synced_at?:string}>}
   */
  async manualSheetSync(storeKey) {
    const res = await fetch(CONFIG_V2.GAS_WEBAPP_URL, {
      method: 'POST',
      // Content-Typeは付けない（text/plain扱い＝CORSプリフライト回避）
      body: JSON.stringify({
        action: 'manual_sync',
        secret: CONFIG_V2.MANUAL_SYNC_SECRET,
        store_key: storeKey
      })
    });
    if (!res.ok) throw new Error('GAS応答エラー: ' + res.status);
    return await res.json();
  },

  // ============================================================
  // 期間・提出データ
  // ============================================================

  /**
   * 自分の所属店舗で受付中（status='open'）の期間を取得
   */
  async getOpenPeriods(storeIds) {
    if (!storeIds || !storeIds.length) return [];
    const res = await this.db.from('shift_periods')
      .select('id, store_id, title, start_date, end_date, deadline, status')
      .eq('status', 'open')
      .in('store_id', storeIds)
      .order('start_date', { ascending: true });
    if (res.error) throw new Error('提出期間の取得に失敗しました: ' + res.error.message);
    return res.data || [];
  },

  /**
   * 指定期間の自分の提出を取得し、カレンダー用 {date, available, start, end} 形式へ変換
   * @returns {Promise<{submissionId:string|null, shifts:Array}>}
   */
  async getMyShifts(periodId) {
    return this.getShiftsOf(periodId, this.user.id);
  },

  /**
   * 指定期間・指定ユーザーの提出をカレンダー用形式で取得。
   * 他人のIDを渡せるのは店長のみ（RLS「店長は自店の提出を閲覧可」が効く。
   * 権限がない場合は行が見えず submissionId:null が返るだけで漏えいしない）。
   * @returns {Promise<{submissionId:string|null, shifts:Array}>}
   */
  async getShiftsOf(periodId, userId) {
    const sub = await this.db.from('submissions')
      .select('id')
      .eq('period_id', periodId)
      .eq('user_id', userId)
      .maybeSingle();
    if (sub.error) throw new Error('提出データの取得に失敗しました: ' + sub.error.message);
    if (!sub.data) return { submissionId: null, shifts: [] };

    const items = await this.db.from('submission_items')
      .select('work_date, shift_type, start_time, end_time')
      .eq('submission_id', sub.data.id)
      .order('work_date', { ascending: true });
    if (items.error) throw new Error('提出明細の取得に失敗しました: ' + items.error.message);

    const shifts = (items.data || []).map(it => {
      if (it.shift_type === 'off' || !it.start_time || !it.end_time) {
        return { date: it.work_date, available: false, start: null, end: null };
      }
      // PostgreSQLのtime型は "HH:MM:SS" で返るので "HH:MM" に揃える
      return {
        date     : it.work_date,
        available: true,
        start    : String(it.start_time).slice(0, 5),
        end      : String(it.end_time).slice(0, 5)
      };
    });

    return { submissionId: sub.data.id, shifts: shifts };
  },

  /**
   * shift_type マッピング規則（設計書準拠）:
   *   出勤不可                               → 'off'
   *   出勤可で start < 15:00 かつ end > 17:00 → 'both'
   *   出勤可で end <= 17:00                   → 'lunch'
   *   それ以外（出勤可）                       → 'dinner'
   */
  shiftTypeOf(shift) {
    if (!shift.available) return 'off';
    if (shift.start < '15:00' && shift.end > '17:00') return 'both';
    if (shift.end <= '17:00') return 'lunch';
    return 'dinner';
  },

  /**
   * 指定店舗の有効なシフト枠を sort_order 昇順で取得（提出画面の枠生成用）。
   * RLS「スタッフは所属店舗の shift_slots を SELECT 可」で自店のみ見える。
   * 数行なので行数上限の心配はない。
   * @param {string} storeId
   * @returns {Promise<Array<{slot_key,name,default_start,default_end,sort_order,is_active}>>}
   */
  async getShiftSlots(storeId) {
    if (!storeId) return [];
    const res = await this.db.from('shift_slots')
      .select('slot_key, name, default_start, default_end, sort_order, is_active')
      .eq('store_id', storeId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (res.error) throw new Error('シフト枠の取得に失敗しました: ' + res.error.message);
    return res.data || [];
  },

  /**
   * シフト提出（DB側RPC submit_shift で1トランザクション保存）
   *
   * 以前はクライアントが submissions upsert → 明細全削除 → 明細insert の
   * 3リクエストに分けていたため、insertだけ失敗すると「submissions行は
   * submitted のまま明細が空」という抜け殻提出が残り得た。submit_shift は
   * この3手順を1関数（1トランザクション）にまとめ、途中失敗なら全部ロール
   * バックする。shift_type の判定はクライアント側に残し、確定済みの items を
   * JSONで渡す。RPCは SECURITY INVOKER なので既存RLSがそのまま効く。
   * @param {Object} period - {id, storeId, ...}（main_v2の期間VM）
   * @param {Array}  shifts - [{date, available, start, end}]
   */
  async submitShift(period, shifts) {
    const items = shifts.map(s => ({
      work_date : s.date,
      shift_type: this.shiftTypeOf(s),
      start_time: s.available ? s.start : null,
      end_time  : s.available ? s.end   : null,
      note      : null
    }));

    const res = await this.db.rpc('submit_shift', {
      p_store_id : period.storeId,
      p_period_id: period.id,
      p_items    : items
    });
    if (res.error) throw new Error('提出の保存に失敗しました: ' + res.error.message);

    return { submissionId: res.data };
  },

  /**
   * 提出直後の念押し確認。DBから自分の提出を読み戻し、保存件数が想定と
   * 一致するかを返す（RPC成功＝コミット保証だが、読み戻しで二重に確かめる）。
   *   true  : 提出が存在し、件数も一致（確認OK）
   *   false : 提出が見当たらない or 件数不一致（異常 → 再提出を促す）
   *   null  : 読み戻し自体が失敗（通信エラー等。判定不能 → 送信成功は信じる）
   * @param {string} periodId
   * @param {number} expectedCount - 提出した明細数（= shifts.length）
   */
  async verifySubmission(periodId, expectedCount) {
    try {
      const result = await this.getShiftsOf(periodId, this.user.id);
      if (!result.submissionId) return false;
      return result.shifts.length === expectedCount;
    } catch (err) {
      console.warn('[verifySubmission] read-back failed, trusting write:', err);
      return null;
    }
  },

  /**
   * 自分の提出履歴（提出済みの期間一覧）を新しい順で取得
   * @returns {Promise<Array<{submission:{id,period_id,submitted_at}, period:{id,store_id,title,start_date,end_date,deadline}}>>}
   */
  async getMyHistory() {
    const uid = this.user.id;

    const subs = await this.db.from('submissions')
      .select('id, period_id, submitted_at')
      .eq('user_id', uid);
    if (subs.error) throw new Error('提出履歴の取得に失敗しました: ' + subs.error.message);
    if (!subs.data || !subs.data.length) return [];

    const per = await this.db.from('shift_periods')
      .select('id, store_id, title, start_date, end_date, deadline')
      .in('id', subs.data.map(s => s.period_id));
    if (per.error) throw new Error('期間情報の取得に失敗しました: ' + per.error.message);

    const byId = {};
    (per.data || []).forEach(p => { byId[p.id] = p; });

    return subs.data
      .map(s => ({ submission: s, period: byId[s.period_id] }))
      .filter(x => x.period)
      .sort((a, b) => (a.period.start_date < b.period.start_date ? 1 : -1));
  },

  // ============================================================
  // 管理者向け（店舗の提出状況）
  // ============================================================

  /**
   * 自分が店長権限を持つ店舗の期間一覧を新しい順で取得
   * @param {Array<string>} storeIds - managedStoreIds()
   */
  async getManagePeriods(storeIds) {
    if (!storeIds || !storeIds.length) return [];
    const res = await this.db.from('shift_periods')
      .select('id, store_id, title, start_date, end_date, deadline, status')
      .in('store_id', storeIds)
      .order('start_date', { ascending: false });
    if (res.error) throw new Error('提出期間の取得に失敗しました: ' + res.error.message);
    return res.data || [];
  },

  /**
   * 指定期間の店舗メンバー一覧と提出有無を取得
   * @param {Object} period - 期間VM（{id, storeId}を使用）
   * @returns {Promise<Array<{id:string, name:string, submitted:boolean}>>}
   */
  async getManageOverview(period) {
    const mem = await this.db.from('store_members')
      .select('user_id, member_code, display_name')
      .eq('store_id', period.storeId)
      .eq('status', 'active');
    if (mem.error) throw new Error('メンバー一覧の取得に失敗しました: ' + mem.error.message);
    const members = mem.data || [];
    if (!members.length) return [];

    // LINE未紐付けの「仮メンバー」は user_id が NULL。NULL を uuid 照会（.in('id', …)）に
    // 渡すと PostgreSQL の 'null'::uuid 変換エラーで画面ごと落ちるため、照会は紐付け済み
    // （user_id 非NULL）の人だけに絞る。仮メンバーは store_members.display_name で表示する。
    const linkedIds = members.map(m => m.user_id).filter(Boolean);

    const nameById = {};
    if (linkedIds.length) {
      const prof = await this.db.from('profiles')
        .select('id, display_name')
        .in('id', linkedIds);
      if (prof.error) throw new Error('メンバー名の取得に失敗しました: ' + prof.error.message);
      (prof.data || []).forEach(p => { nameById[p.id] = p.display_name; });
    }

    const subs = await this.db.from('submissions')
      .select('user_id')
      .eq('period_id', period.id);
    if (subs.error) throw new Error('提出状況の取得に失敗しました: ' + subs.error.message);
    const submittedIds = new Set((subs.data || []).map(s => s.user_id));

    return members
      .map(m => ({
        id        : m.user_id,
        memberCode: m.member_code || '',
        name      : nameById[m.user_id] || m.display_name || '（名前未登録）',
        linked    : !!m.user_id,
        submitted : !!m.user_id && submittedIds.has(m.user_id)
      }))
      .sort((a, b) =>
        a.memberCode.localeCompare(b.memberCode, 'ja', { numeric: true }) ||
        a.name.localeCompare(b.name, 'ja'));
  },

  // ============================================================
  // 店長トップページ（manager-home.html）の提出状況集計
  //
  // 集計ルールは設計書追記_店長トップページ.md の確定版に従う。
  // 分母（対象スタッフ）は include_in_submission=true の紐付け済みメンバー。
  // 役職（role）では絞らない＝「提出する人か否か」を include_in_submission で判定するため、
  // 実際に勤務・提出するオーナー（role='admin'）等も対象に含まれる。
  // データ取得3原則どおり submission_items は一覧では引かない。
  // ============================================================

  /**
   * 店長トップで切り替え表示する期間を最大2件取得する。
   *
   *   open   : 受付中（status='open'）の期間。複数あれば開始日が最も早いものを今期とみなす。
   *   closed : 直近で締め切られた期間（status='closed' のうち start_date が最新のもの）。
   *
   * open だけを見ていた頃は、締切を過ぎた瞬間に「これから組む期間」の提出状況が
   * 見られなくなっていた（2026-07-26に発生）。さらに受付開始日を1日/15日にしたため、
   * 11〜14日・26日〜月末は open が存在しない。closed も併せて返すことで画面が空にならない。
   *
   * どちらも数行の軽いクエリ。submission_items は当然引かない。
   * @returns {Promise<{open:Object|null, closed:Object|null}>}
   */
  async getManagerPeriods(storeId) {
    const COLS = 'id, store_id, title, start_date, end_date, deadline, status';

    const openRes = await this.db.from('shift_periods')
      .select(COLS)
      .eq('store_id', storeId)
      .eq('status', 'open')
      .order('start_date', { ascending: true })
      .limit(1);
    if (openRes.error) throw new Error('受付中の期間の取得に失敗しました: ' + openRes.error.message);

    const closedRes = await this.db.from('shift_periods')
      .select(COLS)
      .eq('store_id', storeId)
      .eq('status', 'closed')
      .order('start_date', { ascending: false })
      .limit(1);
    if (closedRes.error) throw new Error('締切済みの期間の取得に失敗しました: ' + closedRes.error.message);

    return {
      open  : (openRes.data   || [])[0] || null,
      closed: (closedRes.data || [])[0] || null
    };
  },

  /**
   * 提出状況の分母となる対象スタッフを取得（確定ルール）:
   *   status='active' AND user_id IS NOT NULL AND include_in_submission=true AND store_id=対象店
   * role では絞らない（提出対象か否かは include_in_submission 列で判定）。
   * 並びは sort_order 順（詳細一覧の表示順に一致）。
   * @returns {Promise<Array<{id:string, name:string, sortOrder:number}>>}
   */
  async getEligibleStaff(storeId) {
    const mem = await this.db.from('store_members')
      .select('user_id, display_name, sort_order')
      .eq('store_id', storeId)
      .eq('status', 'active')
      .eq('include_in_submission', true)
      .not('user_id', 'is', null)
      .order('sort_order', { ascending: true });
    if (mem.error) throw new Error('対象スタッフの取得に失敗しました: ' + mem.error.message);
    const members = mem.data || [];
    if (!members.length) return [];

    const ids = members.map(m => m.user_id);
    const nameById = {};
    const prof = await this.db.from('profiles')
      .select('id, display_name')
      .in('id', ids);
    if (prof.error) throw new Error('スタッフ名の取得に失敗しました: ' + prof.error.message);
    (prof.data || []).forEach(p => { nameById[p.id] = p.display_name; });

    return members.map(m => ({
      id       : m.user_id,
      name     : nameById[m.user_id] || m.display_name || '（名前未登録）',
      sortOrder: m.sort_order
    }));
  },

  /**
   * 指定期間に提出済みの user_id 集合（distinct）を返す。
   * ここでも submission_items は引かず、submissions の user_id のみ数える。
   * @returns {Promise<Set<string>>}
   */
  async getSubmittedUserIds(periodId) {
    const subs = await this.db.from('submissions')
      .select('user_id')
      .eq('period_id', periodId);
    if (subs.error) throw new Error('提出状況の取得に失敗しました: ' + subs.error.message);
    return new Set((subs.data || []).map(s => s.user_id));
  },

  // ============================================================
  // 確定シフト（店長: たたき台編集〜確定 / スタッフ: 閲覧）
  // ============================================================

  /**
   * たたき台編集に必要なデータ一式を取得（店長専用・RLSで保護）
   * @param {Object} period - 期間VM（{id, storeId}を使用）
   * @returns {Promise<{members:Array, hopes:Object, drafts:Array}>}
   *   hopes[userId][date] = {available, start, end}（提出された希望）
   *   drafts = published_shifts の既存行（たたき台＋確定済み）
   */
  async getDraftData(period) {
    const members = await this.getManageOverview(period);

    const subs = await this.db.from('submissions')
      .select('id, user_id')
      .eq('period_id', period.id);
    if (subs.error) throw new Error('提出の取得に失敗しました: ' + subs.error.message);

    const hopes = {};
    if ((subs.data || []).length) {
      const items = await this.db.from('submission_items')
        .select('submission_id, work_date, shift_type, start_time, end_time')
        .in('submission_id', subs.data.map(s => s.id));
      if (items.error) throw new Error('希望明細の取得に失敗しました: ' + items.error.message);

      const userBySub = {};
      subs.data.forEach(s => { userBySub[s.id] = s.user_id; });
      (items.data || []).forEach(it => {
        const uid = userBySub[it.submission_id];
        if (!hopes[uid]) hopes[uid] = {};
        const available = it.shift_type !== 'off' && !!it.start_time && !!it.end_time;
        hopes[uid][it.work_date] = {
          available: available,
          start: available ? String(it.start_time).slice(0, 5) : null,
          end  : available ? String(it.end_time).slice(0, 5)   : null
        };
      });
    }

    const drafts = await this.db.from('published_shifts')
      .select('user_id, work_date, start_time, end_time, status')
      .eq('period_id', period.id);
    if (drafts.error) throw new Error('たたき台の取得に失敗しました: ' + drafts.error.message);

    return { members: members, hopes: hopes, drafts: drafts.data || [] };
  },

  /**
   * たたき台の1コマを保存。
   * 既に確定済みの行は status を変えず時刻だけ更新する（insert時のみ既定で draft）。
   */
  async saveDraftShift(period, userId, date, start, end) {
    const res = await this.db.from('published_shifts')
      .upsert({
        store_id  : period.storeId,
        period_id : period.id,
        user_id   : userId,
        work_date : date,
        shift_type: this.shiftTypeOf({ available: true, start: start, end: end }),
        start_time: start,
        end_time  : end,
        updated_at: new Date().toISOString()
      }, { onConflict: 'period_id,user_id,work_date' });
    if (res.error) throw new Error('保存に失敗しました: ' + res.error.message);
  },

  /** たたき台の1コマを削除（休みに戻す） */
  async deleteDraftShift(periodId, userId, date) {
    const res = await this.db.from('published_shifts')
      .delete()
      .eq('period_id', periodId)
      .eq('user_id', userId)
      .eq('work_date', date);
    if (res.error) throw new Error('削除に失敗しました: ' + res.error.message);
  },

  /** 提出された希望をたたき台として一括取り込み（既存のコマには触れない） */
  async createDraftFromHopes(period, rows) {
    if (!rows.length) return;
    const res = await this.db.from('published_shifts')
      .upsert(rows.map(r => ({
        store_id  : period.storeId,
        period_id : period.id,
        user_id   : r.userId,
        work_date : r.date,
        shift_type: this.shiftTypeOf({ available: true, start: r.start, end: r.end }),
        start_time: r.start,
        end_time  : r.end
      })), { onConflict: 'period_id,user_id,work_date', ignoreDuplicates: true });
    if (res.error) throw new Error('一括取り込みに失敗しました: ' + res.error.message);
  },

  /** 期間の全コマを確定（公開）する。再実行で変更分も公開される */
  async publishPeriod(periodId) {
    const now = new Date().toISOString();
    const res = await this.db.from('published_shifts')
      .update({ status: 'published', published_at: now, updated_at: now })
      .eq('period_id', periodId);
    if (res.error) throw new Error('確定に失敗しました: ' + res.error.message);
  },

  /** 自分の確定シフトがある期間一覧（新しい順） */
  async getMyPublishedPeriods() {
    const rows = await this.db.from('published_shifts')
      .select('period_id')
      .eq('user_id', this.user.id)
      .eq('status', 'published');
    if (rows.error) throw new Error('確定シフトの取得に失敗しました: ' + rows.error.message);

    const ids = Array.from(new Set((rows.data || []).map(r => r.period_id)));
    if (!ids.length) return [];

    const per = await this.db.from('shift_periods')
      .select('id, store_id, title, start_date, end_date, deadline')
      .in('id', ids);
    if (per.error) throw new Error('期間情報の取得に失敗しました: ' + per.error.message);
    return (per.data || []).sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  },

  /** 指定期間の自分の確定シフト */
  async getMyPublishedShifts(periodId) {
    const res = await this.db.from('published_shifts')
      .select('work_date, start_time, end_time')
      .eq('period_id', periodId)
      .eq('user_id', this.user.id)
      .eq('status', 'published')
      .order('work_date', { ascending: true });
    if (res.error) throw new Error('確定シフトの取得に失敗しました: ' + res.error.message);
    return res.data || [];
  },

  // ============================================================
  // メンバー管理（店長向け・admin-v2.html）
  // 物理削除（DELETE）は提出履歴がcascadeで消えるため絶対に行わない。
  // 退職 = status='retired' へのUPDATEのみ。
  // ============================================================

  /**
   * 店舗のメンバー一覧（active＋retired）を並び順で取得。
   * 表示名は store_members.display_name → profiles.display_name の順で解決し、
   * resolved_name として返す。
   */
  async getStoreMembers(storeId) {
    const res = await this.db.from('store_members')
      .select('id, user_id, display_name, member_code, role, status, sort_order, employment_type')
      .eq('store_id', storeId)
      .in('status', ['active', 'retired'])
      .order('sort_order', { ascending: true })
      .order('member_code', { ascending: true, nullsFirst: false });
    if (res.error) throw new Error('メンバー一覧の取得に失敗しました: ' + res.error.message);
    const rows = res.data || [];

    const userIds = rows.filter(r => r.user_id).map(r => r.user_id);
    const nameById = {};
    if (userIds.length) {
      const prof = await this.db.from('profiles')
        .select('id, display_name')
        .in('id', userIds);
      if (prof.error) throw new Error('メンバー名の取得に失敗しました: ' + prof.error.message);
      (prof.data || []).forEach(p => { nameById[p.id] = p.display_name; });
    }
    rows.forEach(r => {
      r.resolved_name = r.display_name || nameById[r.user_id] || '（名前未設定）';
    });
    return rows;
  },

  /**
   * メンバーを追加（LINE未連携 = user_id NULL で作成。本人の初回ログイン時に連携される）。
   * member_code は渡さない＝DBトリガーが店舗ごとの連番（M0001形式）で自動採番する。
   * employment_type は 'part_time' / 'full_time' / 'admin'。
   */
  async addStoreMember(storeId, displayName, employmentType, sortOrder) {
    const res = await this.db.from('store_members')
      .insert({
        store_id       : storeId,
        user_id        : null,
        display_name   : displayName,
        role           : 'staff',
        status         : 'active',
        employment_type: employmentType || 'part_time',
        sort_order     : sortOrder
      })
      .select('id')
      .single();
    if (res.error) throw new Error('メンバーの追加に失敗しました: ' + res.error.message);
    return res.data.id;
  },

  /** 既存メンバーの雇用区分を変更（'part_time' / 'full_time' / 'admin'） */
  async setStoreMemberEmploymentType(memberId, employmentType) {
    const res = await this.db.from('store_members')
      .update({ employment_type: employmentType })
      .eq('id', memberId);
    if (res.error) throw new Error('雇用区分の変更に失敗しました: ' + res.error.message);
  },

  /**
   * 既存メンバーの役割を変更（'staff' / 'manager' / 'admin'）。
   * 実際に許可されるかはDB側のガード（guard_role_change / prevent_self_escalation）が
   * 判定し、権限外なら日本語のexceptionで弾かれる。そのメッセージをそのまま投げる。
   */
  async setStoreMemberRole(memberId, role) {
    const res = await this.db.from('store_members')
      .update({ role: role })
      .eq('id', memberId);
    if (res.error) throw new Error('役割の変更に失敗しました: ' + res.error.message);
  },

  /** 退職にする（履歴は残る） */
  async retireStoreMember(memberId) {
    const res = await this.db.from('store_members')
      .update({ status: 'retired' })
      .eq('id', memberId);
    if (res.error) throw new Error('退職処理に失敗しました: ' + res.error.message);
  },

  /** 退職者を再雇用（activeに戻し、並び順は末尾へ） */
  async reactivateStoreMember(memberId, sortOrder) {
    const res = await this.db.from('store_members')
      .update({ status: 'active', sort_order: sortOrder })
      .eq('id', memberId);
    if (res.error) throw new Error('再雇用処理に失敗しました: ' + res.error.message);
  },

  /**
   * 表示順どおりに sort_order を 0,1,2... と振り直す。
   * DB関数（reorder_store_members）で1回のリクエスト・1文のUPDATEとして実行する
   * ため、全件成功か全件失敗かのどちらかになり、中途半端な保存が起きない。
   */
  async reorderStoreMembers(orderedIds) {
    const res = await this.db.rpc('reorder_store_members', { ordered_ids: orderedIds });
    if (res.error) throw new Error('並び順の保存に失敗しました: ' + res.error.message);
  }
};
