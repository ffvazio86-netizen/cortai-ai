# Avaliação de integração do AutoClip no Cort-AI

## Decisão técnica

Usar o AutoClip como referência de pipeline, não copiar o aplicativo inteiro para dentro do Cort-AI.

O AutoClip é um aplicativo local-first em Python e declara que downloads anônimos do YouTube podem falhar por verificação de bot. Portanto, copiá-lo não elimina os erros HTTP 429/403 observados no Render.

Referência: https://github.com/Gutsken/Autoclip (licença MIT; confirmar atribuições ao reutilizar código).

## O que aproveitar

- Pipeline em etapas: ingestão, preparação, transcrição, seleção de destaques, enquadramento vertical, legendas e exportação.
- Artefatos por etapa e possibilidade de retomar tarefas que falharam.
- Verificações explícitas de dependências e erros compreensíveis.
- Testes de saída de vídeo: resolução, codec, áudio, duração e legendas.

## O que não copiar diretamente

- A aplicação completa em Python/frontend, pois o Cort-AI atual usa Node.js/Express e uma interface própria.
- Dependências pesadas de IA antes de validar memória, CPU, tempo de execução e custo no Render.
- Qualquer mecanismo que dependa de cookies pessoais do navegador do usuário armazenados no servidor.

## Plano seguro de adaptação

1. Preservar a branch `main`; trabalhar somente na branch de integração.
2. Manter o upload de arquivos como caminho de geração confiável quando o usuário tem direito de processar o vídeo.
3. Melhorar o pipeline de processamento e validação dos MP4s sem alegar que isso contorna bloqueios do YouTube.
4. Para links, distinguir claramente vídeo indisponível/bloqueado de falha durante a edição; testar com URLs públicas autorizadas e registrar o resultado.
5. Só considerar uma integração externa de ingestão se houver acesso autorizado, termos compatíveis, limites e custos conhecidos.
6. Executar os testes automatizados e teste real de geração antes de propor qualquer merge ou deploy.

## Critério de aceite

A integração não será considerada concluída só porque o deploy está verde. Deve haver um teste de ponta a ponta que gere e valide os três MP4s, além de um teste de erro legível quando a origem não puder ser acessada.

## Limitação conhecida

Nenhum código de edição consegue garantir que o YouTube permita baixar qualquer URL a partir de um servidor hospedado. O AutoClip também documenta essa limitação.