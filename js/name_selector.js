/**
 * アレグリア シフト管理ツール - 名前選択画面モジュール
 *
 * 初回起動時のみ表示。
 * GASからメンバーリストを取得 → 店舗別に表示 → タップで自分を選択 →
 * 確認モーダル → GASに登録リクエスト → 期間選択画面へ遷移。
 */
const NameSelector = {

  // 確認モーダルで選択中のメンバー情報を一時保持
  _pendingMember: null,

  // GASのstores配列をフラット化したリスト（インデックス参照用）
  // 各要素: { name, storeId, storeName }
  _members: [],

  /**
   * 名前選択画面を初期化・描画
   * GASからメンバーリストを取得して店舗別に表示する
   */
  async init() {
    const container = document.getElementById('name-list-container');
    container.innerHTML = '<p class="loading-text">メンバーリストを読み込み中…</p>';

    try {
      const result = await API.getMemberList(AppState.userId);

      if (!result.ok) {
        throw new Error(result.error || 'メンバーリストの取得に失敗しました');
      }

      const stores = result.stores || [];

      // stores → フラット配列（インデックス参照用）。renderと同じ順序で構築する
      this._members = stores.flatMap(store =>
        (store.members || []).map(m => ({
          name:      m.name,
          storeId:   store.id,
          storeName: store.name
        }))
      );

      this._renderStores(stores);

    } catch (err) {
      container.innerHTML = `
        <p class="error-text">メンバーリストの読み込みに失敗しました。<br>${err.message}</p>
        <button class="btn-secondary" onclick="NameSelector.init()">再読み込み</button>
      `;
      console.error('[NameSelector] getMemberList:', err);
    }
  },

  /**
   * 店舗別にメンバーリストを描画
   * GASがすでに店舗ごとにグループ化して返すので、そのまま順番に出力する
   * @param {Array<{id:string, name:string, members:Array<{name:string}>}>} stores
   */
  _renderStores(stores) {
    const container = document.getElementById('name-list-container');
    let globalIdx = 0;
    let html = '';

    stores.forEach(store => {
      const members = store.members || [];
      if (members.length === 0) return;

      html += `
        <div class="store-section">
          <h3 class="store-heading">${this._escapeHtml(store.name)}</h3>
          <ul class="member-list">
            ${members.map(m => {
              const idx = globalIdx++;
              return `
                <li class="member-item">
                  <button
                    class="member-btn"
                    onclick="NameSelector._onMemberTap(${idx})"
                  >
                    ${this._escapeHtml(m.name)}
                  </button>
                </li>
              `;
            }).join('')}
          </ul>
        </div>
      `;
    });

    if (html === '') {
      html = '<p class="info-text">メンバーが登録されていません。管理者に連絡してください。</p>';
    }

    container.innerHTML = html;
  },

  /**
   * メンバーボタンがタップされたとき
   * 確認モーダルを開く
   * @param {number} index - this._members 内のインデックス
   */
  _onMemberTap(index) {
    const member = this._members[index];
    if (!member) return;

    this._pendingMember = member;

    // モーダルの名前テキストを差し替えて表示
    document.getElementById('modal-member-name').textContent = member.name;
    document.getElementById('modal-confirm-name').classList.add('active');
  },

  /**
   * 確認モーダル「はい」ボタン
   * GASにメンバー登録をリクエストし、期間選択画面へ進む
   */
  async onConfirmYes() {
    if (!this._pendingMember) return;

    const yesBtn  = document.getElementById('modal-yes-btn');
    const modal   = document.getElementById('modal-confirm-name');

    yesBtn.disabled    = true;
    yesBtn.textContent = '登録中…';

    try {
      const result = await API.registerMember(
        AppState.userId,
        this._pendingMember.name
      );

      if (!result.ok) {
        throw new Error(result.error || '登録に失敗しました');
      }

      // GASが返す member オブジェクトからアプリ全体の状態を更新
      AppState.displayName = result.member.name;
      AppState.store       = result.member.store;
      AppState.role        = result.member.role || 'staff';

      // モーダルを閉じて期間選択画面へ
      modal.classList.remove('active');
      this._pendingMember = null;

      Home.show();

    } catch (err) {
      alert('登録に失敗しました。もう一度お試しください。\n' + err.message);
      console.error('[NameSelector] registerMember:', err);
      yesBtn.disabled    = false;
      yesBtn.textContent = 'はい';
    }
  },

  /**
   * 確認モーダル「いいえ」ボタン
   * モーダルを閉じるだけ（選択状態をリセット）
   */
  onConfirmNo() {
    this._pendingMember = null;
    document.getElementById('modal-confirm-name').classList.remove('active');

    // ボタンを念のためリセット
    const yesBtn = document.getElementById('modal-yes-btn');
    yesBtn.disabled    = false;
    yesBtn.textContent = 'はい';
  },

  /**
   * XSSを防ぐための簡易エスケープ
   * @param {string} str
   * @returns {string}
   */
  _escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
};
