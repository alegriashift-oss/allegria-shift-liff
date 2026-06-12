/**
 * アレグリア シフト管理ツール - 名前選択画面モジュール（Supabase版 v2）
 *
 * 初回起動時のみ表示。
 * line-auth(login) が返した candidates を表示 → タップで自分を選択 →
 * 確認モーダル → line-auth(register) → ホーム画面へ遷移。
 * GAS版と同じ画面・モーダルのマークアップ（index.htmlからコピー）を使う。
 */
const NameSelector = {

  // 確認モーダルで選択中の候補 {id, display_name}
  _pendingCandidate: null,

  // line-auth が返した候補リスト
  _candidates: [],

  /**
   * 名前選択画面を初期化・描画
   * @param {Array<{id:string, display_name:string}>} candidates
   */
  init(candidates) {
    this._candidates = candidates || [];
    this._render();
  },

  /**
   * 候補をlogin呼び出しで再取得して描画し直す
   * （name_already_taken 後のリトライ用）
   */
  async refresh() {
    const container = document.getElementById('name-list-container');
    container.innerHTML = '<p class="loading-text">メンバーリストを読み込み中…</p>';
    try {
      const result = await SupaAPI.login();
      if (result.status === 'ok') {
        // 別経路で連携が完了していた場合はそのままホームへ
        await enterHome();
        return;
      }
      this._candidates = result.candidates || [];
      this._render();
    } catch (err) {
      container.innerHTML = `
        <p class="error-text">メンバーリストの読み込みに失敗しました。<br>${this._escapeHtml(err.message)}</p>
        <button class="btn-secondary" onclick="NameSelector.refresh()">再読み込み</button>
      `;
      console.error('[NameSelector] refresh:', err);
    }
  },

  _render() {
    const container = document.getElementById('name-list-container');

    if (!this._candidates.length) {
      container.innerHTML =
        '<p class="info-text">選択できる名前がありません。管理者に連絡してください。</p>';
      return;
    }

    container.innerHTML = `
      <div class="store-section">
        <ul class="member-list">
          ${this._candidates.map((c, idx) => `
            <li class="member-item">
              <button
                class="member-btn"
                onclick="NameSelector._onMemberTap(${idx})"
              >
                ${this._escapeHtml(c.display_name)}
              </button>
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  },

  /**
   * 候補ボタンがタップされたとき → 確認モーダルを開く
   * @param {number} index - this._candidates のインデックス
   */
  _onMemberTap(index) {
    const candidate = this._candidates[index];
    if (!candidate) return;

    this._pendingCandidate = candidate;

    document.getElementById('modal-member-name').textContent = candidate.display_name;
    document.getElementById('modal-confirm-name').classList.add('active');
  },

  /**
   * 確認モーダル「はい」ボタン
   * line-auth(register) で連携し、ホーム画面へ進む
   */
  async onConfirmYes() {
    if (!this._pendingCandidate) return;

    const yesBtn = document.getElementById('modal-yes-btn');
    const modal  = document.getElementById('modal-confirm-name');

    yesBtn.disabled    = true;
    yesBtn.textContent = '登録中…';

    try {
      const result = await SupaAPI.register(this._pendingCandidate.id);

      if (result.status === 'ok') {
        modal.classList.remove('active');
        this._pendingCandidate = null;
        yesBtn.disabled    = false;
        yesBtn.textContent = 'はい';
        await enterHome();
        return;
      }

      // name_already_taken: メッセージを表示して候補一覧を再取得
      modal.classList.remove('active');
      this._pendingCandidate = null;
      yesBtn.disabled    = false;
      yesBtn.textContent = 'はい';
      alert(result.message || 'その名前はすでに使われています。もう一度選び直してください。');
      await this.refresh();

    } catch (err) {
      alert('登録に失敗しました。もう一度お試しください。\n' + err.message);
      console.error('[NameSelector] register:', err);
      yesBtn.disabled    = false;
      yesBtn.textContent = 'はい';
    }
  },

  /**
   * 確認モーダル「いいえ」ボタン
   */
  onConfirmNo() {
    this._pendingCandidate = null;
    document.getElementById('modal-confirm-name').classList.remove('active');

    const yesBtn = document.getElementById('modal-yes-btn');
    yesBtn.disabled    = false;
    yesBtn.textContent = 'はい';
  },

  _escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
};
