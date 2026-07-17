# 📱 TP Criativos — Teleprompter para gravar criativos

App de teleprompter (PWA) para iPhone: câmera frontal em tela cheia + texto rolando por cima.
O vídeo gravado sai **limpo** (sem o texto). Funciona **100% offline** depois de instalado.

## ✨ Funcionalidades

- 🎥 Câmera frontal em tela cheia (preview espelhado, vídeo gravado normal)
- 📜 Texto rolando com velocidade ajustável (0.5× a 6×) — ajuste fino durante a gravação
- 📦 Caixa do texto **arrastável e redimensionável** — posicione onde quiser, no tamanho que quiser
- 🎨 Cor do texto, cor e transparência do fundo, tamanho da fonte, espaçamento, alinhamento
- 📝 Biblioteca de criativos (textos): criar, colar, editar, excluir — salvos no aparelho
- 🎬 Biblioteca de gravações: assistir, renomear, excluir e **salvar nas Fotos**
- ⏱️ Contagem regressiva antes de gravar (0 a 10s) + rolagem automática ao gravar
- 🪞 Modo espelhado (para teleprompter físico com vidro) e linha-guia de leitura
- 🔆 Mantém a tela acesa durante gravação/rolagem

## 🚀 Como instalar no iPhone

O app precisa estar publicado em uma URL **https** (só para instalar; depois funciona offline):

1. Publique esta pasta em qualquer hospedagem estática (GitHub Pages, Netlify, Vercel, seu VPS…)
2. No iPhone, abra a URL no **Safari**
3. Toque no botão **Compartilhar** (quadrado com seta ↑)
4. Toque em **Adicionar à Tela de Início**
5. Abra o app pelo ícone criado, e **permita câmera e microfone** quando pedir

> ⚠️ Tem que ser pelo **Safari** — Chrome no iOS não instala PWA na tela de início.

### Publicar no GitHub Pages (grátis)

```bash
git init
git add .
git commit -m "feat: TP Criativos v1"
# crie um repositório no GitHub e:
git remote add origin https://github.com/SEU-USUARIO/tp-criativos.git
git push -u origin main
```

Depois, no GitHub: **Settings → Pages → Branch: main → Save**.
A URL fica `https://SEU-USUARIO.github.io/tp-criativos/`.

## 📖 Como usar

1. **📝** → “+ Novo criativo” → cole o texto → “Salvar e usar”
2. Arraste a caixa do texto pela barrinha superior (⠿) e redimensione pelo canto inferior direito
3. **⚙️** → ajuste velocidade, fonte, cores…
4. Botão vermelho → contagem regressiva → gravando (o texto rola sozinho)
5. Botão vermelho de novo → para e salva na biblioteca **🎬**
6. Em **🎬** → “📤 Salvar” → **Salvar Vídeo** (vai para as Fotos do iPhone)

💡 Durante a gravação você pode pausar/retomar a rolagem (▶/⏸) e arrastar o texto com o dedo
para reposicionar a leitura.

## 🎨 Formatação do texto (cores, negrito…)

O texto dos criativos aceita uma marcação simples — é texto puro, então copia e cola de
qualquer lugar (ChatGPT, Notion, WhatsApp…) sem perder a formatação:

| Você escreve | Aparece no teleprompter |
|---|---|
| `**texto**` | **negrito** |
| `*texto*` | *itálico* |
| `__texto__` | sublinhado |
| `==texto==` | destaque com marca-texto (fundo amarelo) |
| `[vermelho]texto[/vermelho]` | texto colorido |
| `[#ff0055]texto[/]` | cor personalizada (hex) |

Cores com nome: `amarelo`, `vermelho`, `verde`, `azul`, `laranja`, `rosa`, `roxo`,
`ciano`, `branco`, `cinza`. Não aninhe uma cor dentro de outra cor.

### Gerando o roteiro com IA já no formato certo

No app: **📝 → editar criativo → “🎨 Formatação” → 📋 Copiar prompt para IA**.
Cole esse prompt no ChatGPT/Claude junto com o seu pedido (ex.: “roteiro de 30s sobre X”)
e a resposta já sai pronta para colar no app.

## 🔧 Detalhes técnicos

- PWA estático: HTML + CSS + JS puros, sem dependências, sem backend
- Textos e configurações: `localStorage` · Vídeos: `IndexedDB` (tudo no aparelho)
- Gravação: `MediaRecorder` — no iPhone sai em **MP4 (H.264)**, compatível com Fotos
- Offline: service worker com cache do app shell ([sw.js](sw.js)) — ao publicar mudanças,
  incremente a `VERSION` no `sw.js`
- Requisito: iOS 16+ (iPhone 14 ✅)

> ⚠️ Os vídeos ficam no armazenamento do navegador. Salve os importantes nas **Fotos**:
> se o app ficar meses sem ser aberto, o iOS pode limpar dados de sites não usados.
