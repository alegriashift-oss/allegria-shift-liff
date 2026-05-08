/**
 * アレグリア シフト管理ツール - 設定ファイル
 * GAS_URL と LIFF_ID を一元管理します。
 * 環境が変わったときはここだけ書き換えてください。
 */
const CONFIG = {
  // Google Apps Script のデプロイURL（doGet / doPost を受け付けるエンドポイント）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbxjW5MSP-rfSYhB-lt7hE0bWYKCp1awIoJmVZIDZG_silblJiuJi0IXOC-OAem49aReNQ/exec',

  // LINE LIFF アプリのID（LINE Developers Console で取得）
  LIFF_ID: '2010000154-reMsR638',

  // 時刻セレクトの範囲設定
  TIME: {
    START_HOUR : 10,   // 開始: 10:00
    END_HOUR   : 23,   // 終了: 23:00
    STEP       : 0.5   // 30分刻み
  },

  // 店舗ラベル（store ID → 表示名）
  STORE_LABELS: {
    jimbocho : '神保町店',
    shibuya  : '渋谷店'
  }
};
