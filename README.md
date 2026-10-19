# Cort-AI — MVP simples

Versão inicial responsiva, preparada para desktop e celular.

## Estado atual

- Tela inicial responsiva em português.
- Endpoint `GET /api/health`.
- Validação de links do YouTube e da Twitch.
- Testes da validação de links.
- **A geração de vídeo ainda não está implementada.** A interface informa isso claramente; nenhum corte fictício é apresentado.

## Executar localmente

Requer Node.js 20 ou superior.

```bash
npm install
npm test
npm start
```

Abra `http://localhost:3000`.

## Próxima etapa

Conectar uma fonte de vídeo que possa ser processada legalmente e integrar FFmpeg para produzir e validar um primeiro arquivo MP4 vertical antes de automatizar três cortes. O projeto não deve contornar restrições de acesso das plataformas. A API oficial de clipes da Twitch, sozinha, não atende à duração de 1 a 5 minutos.
