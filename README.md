Para rodar o codigo precisa estar com o NODE.JS instalado
node server.js -> para rodar o server. Ele esta apenas em modo de escuta, o terminal do server nao executa nenhum comando.
node client.js -> pra rodar os clientes. Precisa dar um nome para cada client.
Para usar as funções dos client. Apos dar um nome precisa rodar o comando register, e logo em seguida uploadkey, para poder atualizar a chave.
Por motivos desconhecidos, antes de enviar uma mensagem para alguem, precisa atualzar a chave, mas enquanto nao encerrar a sessão as chaves continuam valendo, pois são as chaves da sessão.
Deve ser por causa do timestamp que vai no payload.
