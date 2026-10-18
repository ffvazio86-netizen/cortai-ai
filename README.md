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

## Configurar autenticação (sem publicar)

1. Gere um segredo com `openssl rand -base64 48` e configure `CORTAI_SESSION_SECRET` no ambiente do backend.
2. Configure `CORTAI_DATABASE_PATH` para um arquivo no disco persistente, por exemplo `/var/data/cortai-auth.sqlite`, e `CORTAI_STORAGE_DIR=/var/data`. O arquivo SQLite não deve ficar num diretório temporário em produção.
3. Para login Google, crie um OAuth Client ID do tipo aplicação Web no Google Cloud Console, adicione a origem pública exata do Cort-AI em “Authorized JavaScript origins” e configure o valor público do client ID em `GOOGLE_CLIENT_ID`. O backend verifica assinatura, emissor, público, expiração e e-mail verificado do token.
4. Configure `CORTAI_PUBLIC_ORIGIN` com a origem pública exata (esquema e domínio, sem caminho). O cookie de sessão é HttpOnly, SameSite=Lax e Secure em produção.
5. Confirme que a aplicação usa Node.js 22 ou superior para o banco SQLite nativo.
6. Antes de disponibilizar o serviço, teste cadastro, login, logout, login Google, upload, geração e download em uma instância de homologação. Não use `AUTH_REQUIRED=0` em produção.

A autenticação não envia senhas nem tokens Google ao banco em texto claro: senhas são derivadas com scrypt e tokens de sessão são armazenados como hashes.

## Preparar armazenamento persistente no Render (sem publicar)

Se a interface e a API forem hospedadas em origens diferentes, configure `CORTAI_ALLOWED_ORIGIN` com a origem exata da página da interface (esquema + domínio + porta, sem caminho; HTTPS em produção). Não coloque aí a URL da API. O backend só permite CORS com credenciais para essa origem e a interface envia cookies nas requisições. `CORTAI_PUBLIC_ORIGIN` deve ser a origem pública canônica do serviço; com origens separadas, a validação dos pedidos usa a origem explícita de `CORTAI_ALLOWED_ORIGIN`. Em produção, quando `CORTAI_ALLOWED_ORIGIN` está configurada, o cookie usa `SameSite=None; Secure`; alguns navegadores podem bloquear cookies de terceiros, então hospedar interface e API sob o mesmo site/origem é a opção mais confiável. Se interface e API estiverem na mesma origem, não é necessário configurar `CORTAI_ALLOWED_ORIGIN`.

O backend aceita a variável `CORTAI_STORAGE_DIR`, mas o armazenamento só será persistente quando o serviço tiver um disco persistente montado nesse caminho.

1. No painel do Render, abra o serviço web do Cort-AI.
2. Na configuração do serviço, adicione um **Persistent Disk** (se disponível no seu plano).
3. Escolha um caminho de montagem, por exemplo `/var/data`.
4. Em **Environment**, configure:
   - `CORTAI_STORAGE_DIR=/var/data`
   - `CORTAI_DATABASE_PATH=/var/data/cortai-auth.sqlite`
   - `CORTAI_SESSION_SECRET`: valor aleatório com pelo menos 32 bytes (gere localmente com `openssl rand -base64 48`; não o coloque no GitHub).
   - `CORTAI_PUBLIC_ORIGIN`: origem pública canônica, com HTTPS e sem caminho.
   - `AUTH_REQUIRED=1` (não desative a autenticação).
   - `TRUST_PROXY=1` somente se estiver usando o proxy único padrão do Render.
   - Se a interface estiver em outro domínio/origem, configure `CORTAI_ALLOWED_ORIGIN` com a origem exata da interface; se usar Google, configure também `GOOGLE_CLIENT_ID`.
5. Confirme que o diretório do banco e o diretório de arquivos estão no disco persistente e são graváveis pelo processo Node.js.
6. Salve a configuração. Não faça deploy ainda; primeiro confirme que o disco foi criado e que o caminho de montagem corresponde exatamente às variáveis. Nunca coloque segredos no repositório nem em capturas públicas.

A disponibilidade, o custo e as opções de disco dependem do plano atual do Render. A pasta deve ser gravável pelo processo do Node.js. Em múltiplas instâncias, um disco local montado não substitui armazenamento compartilhado apropriado.

### Checklist antes de qualquer deploy

- [ ] Serviço usando Node.js 22 ou superior e o `Dockerfile` (que instala FFmpeg), ou FFmpeg/ffprobe instalados por outro método.
- [ ] Disco persistente criado e montado em `/var/data` (ou caminho escolhido).
- [ ] `CORTAI_STORAGE_DIR` e `CORTAI_DATABASE_PATH` apontam para o disco persistente.
- [ ] `CORTAI_SESSION_SECRET` configurado no painel com valor aleatório de pelo menos 32 bytes.
- [ ] `CORTAI_PUBLIC_ORIGIN` e, quando necessário, `CORTAI_ALLOWED_ORIGIN` conferidos caractere por caractere.
- [ ] `AUTH_REQUIRED=1`; nenhum segredo foi commitado no Git.
- [ ] Testes de cadastro, login/logout, upload, geração e download concluídos em homologação.
- [ ] Plano de backup do SQLite e política de retenção dos vídeos definidos.

Esta lista é preparação, não autorização para publicar. Nenhuma configuração do painel Render foi alterada por este trabalho.

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

- A geração de cortes usa parâmetros fornecidos pelo usuário; ainda não há detecção automática de melhores momentos por IA nem transcrição.
- A autenticação por e-mail/senha está implementada; o login Google depende de `GOOGLE_CLIENT_ID` configurado.
- O armazenamento só é persistente se `CORTAI_STORAGE_DIR` e `CORTAI_DATABASE_PATH` apontarem para um disco persistente configurado. O armazenamento em disco local é adequado para um MVP de instância única, não para produção em escala.
