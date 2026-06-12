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

  _getIdTokenOrThrow() {
    const idToken = liff.getIDToken();
    if (!idToken) {
      throw new Error('LINE認証情報を取得できませんでした。LINEアプリ内で開き直してください。');
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
    throw new Error('登録に失敗しました (HTTP ' + http + '): ' + (body.message || body.code || ''));
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

    const storeNames = {};
    if (memberships.length) {
      const st = await this.db.from('stores')
        .select('id, name')
        .in('id', memberships.map(m => m.store_id));
      if (st.error) throw new Error('店舗情報の取得に失敗しました: ' + st.error.message);
      (st.data || []).forEach(s => { storeNames[s.id] = s.name; });
    }
    memberships.forEach(m => { m.store_name = storeNames[m.store_id] || ''; });

    return { profile: profile, memberships: memberships };
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
    const uid = this.user.id;

    const sub = await this.db.from('submissions')
      .select('id')
      .eq('period_id', periodId)
      .eq('user_id', uid)
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
   * シフト提出（upsert + 明細洗い替え）
   * 1. submissions を upsert（onConflict: period_id,user_id）
   * 2. その submission_id の明細を全削除
   * 3. 新しい明細を一括insert
   * @param {Object} period - {id, storeId, ...}（main_v2の期間VM）
   * @param {Array}  shifts - [{date, available, start, end}]
   */
  async submitShift(period, shifts) {
    const uid = this.user.id;
    const now = new Date().toISOString();

    const up = await this.db.from('submissions')
      .upsert({
        store_id    : period.storeId,
        user_id     : uid,
        period_id   : period.id,
        status      : 'submitted',
        submitted_at: now,
        updated_at  : now
      }, { onConflict: 'period_id,user_id' })
      .select('id')
      .single();
    if (up.error) throw new Error('提出の保存に失敗しました: ' + up.error.message);
    const submissionId = up.data.id;

    const del = await this.db.from('submission_items')
      .delete()
      .eq('submission_id', submissionId);
    if (del.error) throw new Error('既存明細の削除に失敗しました: ' + del.error.message);

    const rows = shifts.map(s => ({
      submission_id: submissionId,
      work_date    : s.date,
      shift_type   : this.shiftTypeOf(s),
      start_time   : s.available ? s.start : null,
      end_time     : s.available ? s.end   : null,
      note         : null
    }));
    if (rows.length) {
      const ins = await this.db.from('submission_items').insert(rows);
      if (ins.error) throw new Error('明細の保存に失敗しました: ' + ins.error.message);
    }

    return { submissionId: submissionId };
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
  }
};
