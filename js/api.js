/**
 * アレグリア シフト管理ツール - GAS通信モジュール
 *
 * Google Apps Script (doGet / doPost) との fetch ベースの通信を担当します。
 *
 * 【GASのCORS対応について】
 * - GET : 通常の fetch で OK（GASがCORSヘッダーを付与）
 * - POST: Content-Type を "text/plain" にすることでプリフライトを回避。
 *         GAS側は e.postData.contents を JSON.parse して読む。
 */
const API = {

  _accessToken: null,

  setAccessToken(accessToken) {
    this._accessToken = accessToken;
  },

  // ============================================================
  // 内部ユーティリティ
  // ============================================================

  /**
   * GETリクエスト共通処理
   * @param {Object} params - URLクエリパラメータ { key: value, ... }
   * @returns {Promise<Object>} GASが返す JSON オブジェクト
   */
  async _get(params) {
    const url = new URL(CONFIG.GAS_URL);
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

    const response = await fetch(url.toString(), {
      method : 'GET',
      mode   : 'cors'
    });

    if (!response.ok) {
      throw new Error(`GAS GET エラー: HTTP ${response.status}`);
    }
    return response.json();
  },

  /**
   * POSTリクエスト共通処理
   * Content-Type を text/plain にしてプリフライトを回避する。
   * @param {Object} data - 送信するJSONオブジェクト
   * @returns {Promise<Object>} GASが返す JSON オブジェクト
   */
  async _post(data) {
    const response = await fetch(CONFIG.GAS_URL, {
      method  : 'POST',
      mode    : 'cors',
      headers : { 'Content-Type': 'text/plain;charset=utf-8' },
      body    : JSON.stringify(data)
    });

    if (!response.ok) {
      throw new Error(`GAS POST エラー: HTTP ${response.status}`);
    }
    return response.json();
  },

  _withAuth(data) {
    if (!this._accessToken) {
      throw new Error('LINE認証情報が取得できませんでした');
    }
    return Object.assign({}, data, { accessToken: this._accessToken });
  },

  // ============================================================
  // 公開API
  // ============================================================

  /**
   * LINE User ID がメンバーとして登録済みかチェック
   * GAS側: doGet({ action: 'check_member', userId })
   * @param {string} userId - LINE User ID
   * @returns {Promise<{ok:boolean, registered:boolean, member?:{name:string, store:string}}>}
   */
  checkMember(userId) {
    return this._post(this._withAuth({ action: 'check_member', userId }));
  },

  /**
   * 全メンバーリストを取得（初回名前選択に使用）
   * GAS側: doPost({ action: 'get_member_list', userId, accessToken })
   * @param {string} userId - LINE User ID
   * @returns {Promise<{ok:boolean, stores:Array<{id:string, name:string, members:Array<{name:string}>}>}>}
   */
  getMemberList(userId) {
    return this._post(this._withAuth({ action: 'get_member_list', userId }));
  },

  /**
   * 提出可能な期間リストを取得
   * GAS側: doGet({ action: 'get_periods' })
   * @returns {Promise<{ok:boolean, locked:boolean, periods:Array<{id,label,start,end,deadline,isOpen}>, nextPeriod?:{start:string,startLabel:string,targetLabel:string}}>}
   */
  getPeriods() {
    return this._get({ action: 'get_periods' });
  },

  /**
   * 指定期間の自分の提出済みシフトを取得
   * GAS側: doGet({ action: 'get_my_shifts', userId, period })
   * @param {string} userId
   * @param {string} period - 期間ID (例: "2026-05-latter")
   * @returns {Promise<{ok:boolean, shifts:Array<{date,available,start,end}>}>}
   */
  getMyShifts(userId, period) {
    return this._post(this._withAuth({ action: 'get_my_shifts', userId, period }));
  },

  getMyHistory(userId) {
    return this._post(this._withAuth({ action: 'get_my_history', userId }));
  },

  getMyHistoryDetail(userId, period) {
    return this._post(this._withAuth({ action: 'get_my_history_detail', userId, period }));
  },

  getManagePeriods(userId) {
    return this._post(this._withAuth({ action: 'get_manage_periods', userId }));
  },

  getManageOverview(userId, period, storeId) {
    return this._post(this._withAuth({ action: 'get_manage_overview', userId, period, storeId }));
  },

  getManageDetail(userId, period, memberId) {
    return this._post(this._withAuth({ action: 'get_manage_detail', userId, period, memberId }));
  },

  /**
   * 名前選択時のメンバー紐付け登録
   * GAS側: doPost({ action: 'register_member', userId, displayName })
   * @param {string} userId
   * @param {string} displayName - 選択した本名
   * @returns {Promise<{ok:boolean, member?:{name:string, store:string}, error?:string}>}
   */
  registerMember(userId, displayName) {
    return this._post(this._withAuth({ action: 'register_member', userId, displayName }));
  },

  /**
   * シフト提出
   * GAS側: doPost({ action: 'submit_shift', userId, period, shifts })
   * @param {string} userId
   * @param {string} period - 期間ID
   * @param {Array<{date:string, available:boolean, start:string|null, end:string|null}>} shifts
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  submitShift(userId, period, shifts) {
    return this._post(this._withAuth({ action: 'submit_shift', userId, period, shifts }));
  }
};
