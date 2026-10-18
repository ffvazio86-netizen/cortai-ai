# Cort-AI

Interface do Cort-AI e backend em desenvolvimento; a autenticação precisa de configuração de ambiente antes de ficar disponível em produção.

## Requisitos

- Node.js 22 ou superior
- npm
- FFmpeg e ffprobe instalados e disponíveis no PATH

## Iniciar o backend

```bash
npm install
npm start
```

Por padrão, a API escuta em `http://localhost:3000`. Verifique `http://localhost:3000/api/health`. A resposta informa se o executável FFmpeg está disponível. Para usar a autenticação localmente, defina `CORTAI_SESSION_SECRET` antes de iniciar o servidor. O login Google só aparece quando `GOOGLE_CLIENT_ID` estiver configurado.

## Upload e geração de cortes

1. Envie um vídeo com `POST /api/videos` usando `multipart/form-data` e o campo `video`. São aceitos MP4, MOV, WebM e MKV, até 100 MB.
2. Guarde o `video.id` devolvido no sucesso (HTTP 201).
3. Gere um corte com `POST /api/videos/:videoId/cuts`, enviando JSON com `startSeconds` e `durationSeconds`. O início deve ser não negativo e a duração deve ser maior que zero e no máximo 60 segundos, sem ultrapassar o fim do vídeo.
4. A resposta inclui `cut.id` e `cut.downloadUrl`. Baixe o MP4 usando `GET /api/cuts/:cutId/download`.

Exemplo de corpo para gerar um corte de 15 segundos a partir do segundo 10:

```json
{
  "startSeconds": 10,
  "durationSeconds": 15
}
```

Por padrão, os arquivos ficam em uma pasta temporária do sistema operacional e podem desaparecer após reinícios ou limpeza. O backend limita o armazenamento de vídeos e cortes a 500 MB (`CORTAI_MAX_STORAGE_MB`), reserva até 100 MB para cada upload ou corte em andamento e remove arquivos de vídeo com mais de 2 horas (`CORTAI_FILE_TTL_HOURS`), verificando a pasta periodicamente e antes de aceitar uploads. O limite reserva espaço para o tamanho máximo de upload (100 MB) e para cada corte em andamento (até 100 MB), inclusive quando há operações simultâneas. O FFmpeg recebe um limite de saída de 100 MB por corte; a API verifica o tamanho final antes de disponibilizar o arquivo. Esses valores podem ser ajustados por variáveis de ambiente. Para escolher outra pasta, configure `CORTAI_STORAGE_DIR` antes de iniciar o servidor. Em uma hospedagem como Render, essa variável deve apontar para o caminho de montagem de um disco persistente configurado no próprio serviço (por exemplo, `/var/data`, se esse for o caminho escolhido). Configurar a variável, sozinho, **não cria** o disco nem garante persistência.

A autenticação por e-mail/senha e Google está habilitada por padrão. As rotas de upload, geração e download exigem sessão e os IDs de vídeos/cortes são associados ao usuário que os criou. Use `CORTAI_SESSION_SECRET` com pelo menos 32 bytes aleatórios e configure `GOOGLE_CLIENT_ID` para habilitar o botão Google. A base SQLite de usuários e sessões fica em `CORTAI_DATABASE_PATH` (por padrão, ao lado dos arquivos no diretório `CORTAI_STORAGE_DIR`). Em produção, configure `CORTAI_STORAGE_DIR` para o ponto de montagem do disco persistente e `CORTAI_DATABASE_PATH` para um arquivo nesse mesmo disco; faça backup do banco e mantenha o mesmo `CORTAI_SESSION_SECRET` entre reinícios. SQLite usa arquivos auxiliares WAL/SHM, então o diretório do banco precisa permitir gravação. Não defina `AUTH_REQUIRED=0` em um serviço público.

## Configurar autenticação (sem publicar)\n\n1. Gere um segredo com `openssl rand -base64 48` e configure `CORTAI_SESSION_SECRET` no ambiente do backend.\n2. Configure `CORTAI_DATABASE_PATH` para um arquivo no disco persistente, por exemplo `/var/data/cortai-auth.sqlite`, e `CORTAI_STORAGE_DIR=/var/data`. O arquivo SQLite não deve ficar num diretório temporário em produção.\n3. Para login Google, crie um OAuth Client ID do tipo aplicação Web no Google Cloud Console, adicione a origem pública exata do Cort-AI em “Authorized JavaScript origins” e configure o valor público do client ID em `GOOGLE_CLIENT_ID`. O backend verifica assinatura, emissor, público, expiração e e-mail verificado do token.\n4. Configure `CORTAI_PUBLIC_ORIGIN` com a origem pública exata (esquema e domínio, sem caminho). O cookie de sessão é HttpOnly, SameSite=Lax e Secure em produção.\n5. Confirme que a aplicação usa Node.js 22 ou superior para o banco SQLite nativo.\n6. Antes de disponibilizar o serviço, teste cadastro, login, logout, login Google, upload, geração e download em uma instância de homologação. Não use `AUTH_REQUIRED=0` em produção.\n\nA autenticação não envia senhas nem tokens Google ao banco em texto claro: senhas são derivadas com scrypt e tokens de sessão são armazenados como hashes.\n\n## Preparar armazenamento persistente no Render (sem publicar)

O backend aceita a variável `CORTAI_STORAGE_DIR`, mas o armazenamento só será persistente quando o serviço tiver um disco persistente montado nesse caminho.

1. No painel do Render, abra o serviço web do Cort-AI.
2. Na configuração do serviço, adicione um **Persistent Disk** (se disponível no seu plano).
3. Escolha um caminho de montagem, por exemplo `/var/data`.
4. Em **Environment**, adicione `CORTAI_STORAGE_DIR=/var/data`.
5. Se o serviço estiver atrás do proxy único padrão do Render, configure também `TRUST_PROXY=1` para que os limites por IP funcionem corretamente.
6. Salve a configuração. Não faça deploy ainda; primeiro confirme que o disco foi criado e que o caminho de montagem corresponde exatamente à variável.

A disponibilidade, o custo e as opções de disco dependem do plano atual do Render. A pasta deve ser gravável pelo processo do Node.js. Em múltiplas instâncias, um disco local montado não substitui armazenamento compartilhado apropriado.

## Proteção básica contra abuso

- Uploads: até 10 requisições por IP em 15 minutos.
- Geração de cortes: até 20 requisições por IP em 15 minutos.
- O Express confia em proxy reverso somente quando `TRUST_PROXY=1`. Em Render, configure essa variável como `1` se o serviço estiver atrás do proxy único padrão da plataforma; localmente, deixe `0`.
- O limitador usa memória do processo. Em múltiplas instâncias, os contadores não são compartilhados; para produção com escala, use um armazenamento compartilhado de rate limit.
- Os limites por IP não substituem autenticação, limites de custo ou proteção de concorrência de processamento.
- O limite de armazenamento e a limpeza automática são proteções básicas para um MVP de instância única; não substituem armazenamento dedicado, monitoramento ou quotas compartilhadas em múltiplas instâncias.

## Testes

```bash
npm test
```

Os testes usam o executor nativo do Node.js e geram vídeos de teste com FFmpeg. É necessário instalar as dependências e ter FFmpeg/ffprobe no PATH.

## FFmpeg em contêiner

O `Dockerfile` instala o FFmpeg para executar o backend em contêiner. Nenhum serviço foi publicado no Render por esta alteração.

## Limitações atuais

- A geração de cortes usa parâmetros fornecidos pelo usuário; não há detecção automática de melhores momentos por IA.
- Não há transcrição, armazenamento permanente, autenticação ou autorização.
- O diretório de upload temporário não é um sistema de armazenamento de produção.
