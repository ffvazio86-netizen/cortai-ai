# Cort-AI

Site responsivo em português para gerar três cortes verticais a partir de links públicos do YouTube e da Twitch, com confirmação de autorização.

## O que o MVP faz
- Aceita links do YouTube e da Twitch.
- Exige confirmação de autorização antes do processamento.
- Usa `yt-dlp` para obter o vídeo e `ffmpeg/ffprobe` para gerar três MP4 verticais (1080×1920), sem legendas.
- Cria trechos de 1 a 5 minutos, conforme a duração do vídeo.
- Mostra o andamento e oferece links para baixar os arquivos.
- Permite apenas um processamento por vez.
- Limita o armazenamento padrão a 5 GiB, contabiliza arquivos temporários e cortes gerados, reserva espaço para um novo processamento e remove automaticamente cortes com mais de 24 horas.

## Limitações importantes
Os trechos são distribuídos ao longo do vídeo; **esta versão ainda não usa IA para identificar semanticamente os melhores momentos**. O processamento real de vídeo ainda precisa ser validado com links públicos que possam ser acessados legalmente. A CI testa a API e o endpoint de saúde, gera três cortes a partir de um vídeo sintético e verifica que os MP4 têm formato vertical. Ela usa um simulador para a etapa de download; ainda não confirma downloads reais do YouTube/Twitch.

Links privados, restritos por idade/região, transmissões ao vivo ou vídeos que a ferramenta não consiga acessar podem falhar. O servidor precisa de CPU, memória e armazenamento suficientes.

Use somente vídeos que você possui ou para os quais tem permissão de baixar, editar e publicar. Respeite os termos do YouTube/Twitch e os direitos do criador. Não contorne paywalls, autenticação ou restrições de acesso.

## Executar localmente
Requisitos: Node.js 20+, FFmpeg/FFprobe e yt-dlp instalados e disponíveis no PATH.

```sh
npm ci
npm test
npm start
```

Abra http://localhost:3000.

## Login com Google (configuração ainda necessária)

O MVP inclui as rotas de início e retorno OAuth e um cookie de sessão assinado. Para habilitar o login no Render, configure estas variáveis privadas no serviço:

- `GOOGLE_CLIENT_ID`: ID do cliente OAuth criado no Google Cloud.
- `GOOGLE_CLIENT_SECRET`: segredo do cliente OAuth; mantenha-o apenas nas variáveis privadas do servidor.
- `GOOGLE_REDIRECT_URI`: URL completa de retorno, por exemplo `https://cortai-ai-teste.onrender.com/auth/google/callback`. O valor precisa ser idêntico ao URI autorizado no Google Cloud.
- `SESSION_SECRET`: segredo aleatório longo e exclusivo para assinar a sessão.

No Google Cloud, a origem JavaScript autorizada é `https://cortai-ai-teste.onrender.com`; o URI de redirecionamento autorizado deve ser `https://cortai-ai-teste.onrender.com/auth/google/callback` se esse for o endereço definitivo do serviço. Não crie credenciais até confirmar o domínio de produção/teste e configurar as variáveis. O login identifica o usuário, mas esta etapa ainda não restringe os endpoints de processamento nem separa os arquivos por usuário.

## Configuração de armazenamento
Variáveis opcionais:
- `PORT`: porta HTTP (padrão `3000`).
- `CORTAI_DATA_DIR`: diretório dos arquivos temporários e cortes.
- `CORTAI_MAX_STORAGE_BYTES`: limite total de arquivos temporários e cortes (padrão 5 GiB).
- `CORTAI_RESERVED_JOB_BYTES`: espaço reservado para o próximo processamento (padrão 1 GiB).
- `CORTAI_OUTPUT_RETENTION_MS`: tempo de retenção dos cortes (padrão 24 horas em milissegundos).

## Docker
```sh
docker build -t cortai .
docker run --rm -p 3000:3000 -v cortai-data:/data cortai
```

## API
- `GET /api/health`: health check.
- `POST /api/cuts`: body JSON `{"url":"https://youtu.be/...","authorized":true}`.
- `GET /api/jobs/:id`: status e links dos cortes.

## Antes de disponibilizar publicamente
Esta versão não possui login, fila persistente nem isolamento de arquivos por usuário. Os status dos jobs ficam na memória e reiniciar o servidor apaga esse histórico. Antes de uma publicação pública, é necessário implementar autenticação/limites por usuário, proteção contra abuso, monitoramento e uma política de privacidade adequada.
