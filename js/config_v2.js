/**
 * アレグリア シフト管理ツール - Supabase版 設定ファイル（v2）
 *
 * GAS版の config.js には手を加えず、Supabase接続替え用の設定をここに置く。
 * 環境が変わったときはここだけ書き換える。
 */
const CONFIG_V2 = {
  SUPABASE_URL: 'https://nlyzzrglnqmcsbvcwiav.supabase.co',

  // anonキーはフロント公開前提（RLSで保護される）。service_roleは絶対に置かない。
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5seXp6cmdsbnFtY3NidmN3aWF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNDYwOTAsImV4cCI6MjA5NjgyMjA5MH0.FtbiB6J5eJpINYkwZleRmRdpjpEDvfISuBahIayJS1g',

  // LINE IDトークン検証＋Supabaseセッション発行を行うEdge Function
  LINE_AUTH_URL: 'https://nlyzzrglnqmcsbvcwiav.supabase.co/functions/v1/line-auth',

  // テストLIFF ID。本番切替時は 2010000154-reMsR638 に変更する。
  LIFF_ID: '2010000154-2C3b8v2x'
};
