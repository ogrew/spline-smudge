# 引伸 INSHIN

**写真から色を曳いて、のばす・つなぐ・たどる。** 写真の色をスプラインに沿って引き伸ばし、新しいグラフィックをつくるブラウザツールです。TypeScript + WebGL2 + GLSL。

名前は暗室の引伸機から。プリントが解釈の場であったように、撮ったあとの第二幕をつくるための道具です。

公開サイト：[https://ogrew.github.io/spline-smudge/](https://ogrew.github.io/spline-smudge/)

## 使い方

1. 「画像を選択」でJPG／PNGを読み込む
2. 写真をクリックして点を置き、曲線をつくる（ドラッグで移動、ダブルクリックで削除）
3. **のばす**／**つなぐ**／**たどる**を切り替え、太さ・採取線・色補間を調整する
4. 「エクスポート」でPNGを保存する

画像はブラウザ内で処理され、外部へ送信されません。詳しい操作は[操作ガイド](docs/manual.md)を参照してください。

## 開発

Node.js 22.18以上。

```sh
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # 数学・状態のユニットテスト
npm run build      # 型検査と本番ビルド
npm run test:browser  # 実ブラウザ検証（dev server起動とChromeが必要）
```

mainへのpushで `.github/workflows/pages.yml` がGitHub Pagesへ自動配信します。

## ドキュメント

- [docs/manual.md](docs/manual.md) — 操作ガイド（全機能のリファレンス）
- [docs/implementation.md](docs/implementation.md) — 実装メモ（構成・描画パイプライン・テスト）
- [docs/roadmap.md](docs/roadmap.md) — 評価待ちの項目と今後の課題
