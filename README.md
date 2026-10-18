# Cort-AI

Interface estática do Cort-AI e backend inicial para desenvolvimento local.

## Requisitos

- Node.js 20 ou superior
- npm
- FFmpeg e ffprobe instalados e disponíveis no PATH

## Iniciar o backend

```bash
npm install
npm start
```

Por padrão, a API escuta em `http://localhost:3000`. Verifique `http://localhost:3000/api/health`. A resposta informa se o executável FFmpeg está disponível.

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

Por padrão, os arquivos ficam em uma pasta temporária do sistema operacional e podem desaparecer após reinícios ou limpeza. Para escolher outra pasta, configure `CORTAI_STORAGE_DIR` antes de iniciar o servidor. Em uma hospedagem como Render, essa variável deve apontar para o caminho de montagem de um disco persistente configurado no próprio serviço (por exemplo, `/var/data`, se esse for o caminho escolhido). Configurar a variável, sozinho, **não cria** o disco nem garante persistência.

Não envie vídeos privados ou sensíveis para uma instância pública: autenticação e autorização ainda não estão implementadas. Antes de produção, também é necessário configurar limites de uso e proteção contra abuso.

## Preparar armazenamento persistente no Render (sem publicar)

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
