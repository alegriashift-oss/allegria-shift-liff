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

  // 本番LIFF ID。テストに戻すときは 2010000154-2C3b8v2x に変更する。
  LIFF_ID: '2010000154-reMsR638',

  // GAS WebアプリURL（既存の /exec デプロイURL）。手動シート更新FABが叩く。
  // ※GASを「既存デプロイの更新」で再デプロイすればURLは不変。もし現行と異なれば
  //   GASの「デプロイを管理」に表示される実URLへ差し替えること。
  GAS_WEBAPP_URL: 'https://script.google.com/macros/s/AKfycbxxnDxCe0CDHFj1GIPzgtwxEMwkqIG0jrGcfuO4ZxNDv6OcGmephB3gWMxySNfTZ2sV/exec',

  // 手動同期の軽量シークレット（GASのスクリプトプロパティ MANUAL_SYNC_SECRET と一致させる）。
  // これは「公開URLの空打ち防止」の軽い鍵。漏れても被害は同期が1回走る程度で、
  // 読み取り権限の本物の鍵(EXPORT_TOKEN)とは別物のため、LIFFに置いてよい。
  MANUAL_SYNC_SECRET: 'fd7b14b0891fc769f658ee0a4bc33469'
};
