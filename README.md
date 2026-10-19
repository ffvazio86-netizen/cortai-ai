# Cort-AI

Site responsivo para iniciar a criação de cortes verticais a partir de links públicos do YouTube e Twitch que o usuário tenha autorização para processar.

## MVP inicial
- Interface em português, responsiva para computador e celular.
- Aceita links de YouTube e Twitch.
- Exige confirmação de autorização para processar o vídeo.
- Backend Express com status de processamento.
- Usa `yt-dlp` para obter a mídia e `ffmpeg/ffprobe` para gerar três MP4 verticais 1080x1920, sem legendas.
- Os arquivos são apresentados para download.

## Importante: estágio do produto
Esta é a primeira implementação do fluxo real, ainda **não validada em execução neste ambiente**. O MVP distribui os três trechos ao longo do vídeo; ele ainda não reconhece semanticamente os “melhores momentos” com IA. A seleção inteligente será uma etapa posterior, depois que a geração básica funcionar.

O processamento depende de `yt-dlp`, `ffmpeg` e `ffprobe` disponíveis no servidor. Links privados, restritos por idade/região, transmissões ao vivo ou vídeos que a ferramenta não consiga acessar podem falhar. O servidor precisa de armazenamento e memória suficientes para os vídeos.

Use somente vídeos que você possui ou para os quais tem permissão de baixar, editar e publicar. Respeite os termos do YouTube/Twitch e os direitos do criador. Não contorne paywalls, autenticação ou restrições de acesso.

## Executar localmente
Requisitos: Node.js 20+, FFmpeg/FFprobe e yt-dlp instalados e disponíveis no PATH.

```sh
npm install
npm test
npm start
```

Abra `http://localhost:3000`.

## Docker
```sh
docker build -t cortai .
docker run --rm -p 3000:3000 -v cortai-data:/data cortai
```

Defina `CORTAI_DATA_DIR` para um volume persistente em produção. Os jobs ficam na memória e os arquivos gerados não têm limpeza automática nesta versão, então é necessário monitorar armazenamento e reiniciar o serviço após manutenção.

## API
- `GET /api/health`: health check.
- `POST /api/cuts`: body JSON `{"url":"https://youtu.be/...","authorized":true}`.
- `GET /api/jobs/:id`: status e links dos cortes.

Não há login ou isolamento de arquivos por usuário nesta versão. Não a exponha publicamente sem acrescentar autenticação, limites de armazenamento, limpeza automática, proteção contra abuso e uma fila persistente.
