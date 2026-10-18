# Cort-AI

Interface estática do Cort-AI e backend inicial para desenvolvimento local.

## Requisitos

- Node.js 20 ou superior
- npm
- FFmpeg instalado e disponível no PATH para testar processamento de mídia

## Iniciar o backend

```bash
npm install
npm start
```

Por padrão, a API escuta em `http://localhost:3000`. Verifique `http://localhost:3000/api/health`. A resposta informa se o executável FFmpeg está disponível. O estado `degraded` indica que a API responde, mas o FFmpeg não foi encontrado ou não passou na verificação.

## Testes

```bash
npm test
```

Os testes usam o executor nativo do Node.js e precisam das dependências instaladas com `npm install`.

## FFmpeg em contêiner

O `Dockerfile` instala o FFmpeg e prepara o backend em um contêiner para testes. Nenhum serviço foi publicado no Render por esta alteração.

## Limitações atuais

- Ainda não há upload nem processamento real de vídeos.
- O endpoint de saúde apenas verifica se o executável `ffmpeg` está disponível.
- Não há integração com IA, transcrição, armazenamento permanente ou autenticação.
