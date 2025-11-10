// client.js
import fs from "fs";
import path from "path";
import readline from "readline";
import crypto from "crypto";

const SERVER = "http://127.0.0.1:8000";

class Client {
  constructor(username) {
    this.username = username;
    this.clientDir = "client_data";
    if (!fs.existsSync(this.clientDir)) fs.mkdirSync(this.clientDir);
    this.identityFile = path.join(this.clientDir, `${username}_identity.json`);
    this.sessionFile = path.join(this.clientDir, `${username}_sessions.json`);
    this.prekeyFile = path.join(this.clientDir, `${username}_prekey.json`);
    this.groupsFile = path.join(this.clientDir, `${username}_groups.json`);

    this.identity = this.loadJSON(this.identityFile, null);
    this.sessions = this.loadJSON(this.sessionFile, {});
    this.prekey = this.loadJSON(this.prekeyFile, null);
    this.groups = this.loadJSON(this.groupsFile, {});
  }

  loadJSON(file, fallback) {
    try {
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  saveJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  async generateKeyPair() {
    try {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
      console.log("Public key: ", publicKey, "  Private key: ", privateKey) //criação das chaves publicas e privadas
      return {
        pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
      };
    } catch (error) {
      console.error("Erro ao gerar par de chaves:", error);
      throw error;
    }
  }

  getPrivateKey(keyData = this.identity) {
    if (!keyData?.priv) throw new Error("Chave privada não carregada");
    
    try {
      return crypto.createPrivateKey({
        key: Buffer.from(keyData.priv, 'base64'),
        type: 'pkcs8',
        format: 'der'
      });
    } catch (error) {
      console.error("Erro ao carregar chave privada:", error);
      throw error;
    }
  }

  // KDF consistente e determinístico
  deriveSessionKey(sharedSecret, peerUsername) {
    const users = [this.username, peerUsername].sort();
    const seed = `${users[0]}-${users[1]}-session-key`;
    
    const material = Buffer.concat([
      sharedSecret,
      Buffer.from(seed, 'utf8')
    ]);
    console.log(`Material: ${material}`);
    
    let key = crypto.createHash('sha256').update(material).digest();
    //console.log(`Chave criptografada: ${key}`); //printando a chave criptografada
    key = crypto.createHash('sha256').update(key).digest();
    //console.log(`Chave atualizada: ${key}`); //printando a chave criptografada
    
    return key.slice(0, 32);
  }

  async makeRequest(url, options) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
      }
      return await response.json();
    } catch (error) {
      console.error(`Erro na requisição para ${url}:`, error.message);
      throw error;
    }
  }

  async register() {
    try {
      if (!this.identity) {
        console.log("🔑 Gerando par de chaves de identidade...");
        this.identity = await this.generateKeyPair();
        this.saveJSON(this.identityFile, this.identity);
      }

      const result = await this.makeRequest(`${SERVER}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          user: this.username, 
          identity_pub: this.identity.pub 
        }),
      });
      
      console.log("✅ Registro realizado com sucesso!");
      
      // Verificar se foi adicionado automaticamente a algum grupo
      if (result.auto_joined_groups && result.auto_joined_groups.length > 0) {
        console.log(`🎉 Adicionado automaticamente aos grupos: ${result.auto_joined_groups.join(', ')}`);
        for (const groupId of result.auto_joined_groups) {
          // Buscar info do grupo para obter a versão correta
          try {
            const groupInfo = await this.makeRequest(`${SERVER}/group_info/${groupId}`);
            this.groups[groupId] = { version: groupInfo.version };
            console.log(`   ✅ Grupo ${groupId} versão ${groupInfo.version}`);
          } catch (err) {
            console.log(`   ❌ Erro ao obter info do grupo ${groupId}:`, err.message);
          }
        }
        this.saveJSON(this.groupsFile, this.groups);
      }
      
    } catch (err) {
      console.error("❌ Erro no registro:", err.message);
    }
  }

  async uploadPrekey() {
    if (!this.identity) {
      console.log("❌ Usuário não registrado. Execute 'register' primeiro.");
      return;
    }
    
    try {
      console.log("🔑 Gerando prekey...");
      this.prekey = await this.generateKeyPair();
      this.saveJSON(this.prekeyFile, this.prekey);

      await this.makeRequest(`${SERVER}/upload_prekey`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          user: this.username, 
          x25519_pub: this.prekey.pub 
        }),
      });
      
      console.log("✅ Prekey enviada com sucesso!");
      
    } catch (err) {
      console.error("❌ Erro no upload da prekey:", err.message);
    }
  }

  async checkAutoJoin() {
    try {
      console.log("🔍 Verificando convites de grupo pendentes...");
      const result = await this.makeRequest(`${SERVER}/auto_join_groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          user: this.username
        }),
      });
      
      if (result.joined_groups && result.joined_groups.length > 0) {
        console.log(`🎉 Adicionado automaticamente aos grupos: ${result.joined_groups.join(', ')}`);
        for (const groupId of result.joined_groups) {
          // Buscar info do grupo para obter a versão correta
          try {
            const groupInfo = await this.makeRequest(`${SERVER}/group_info/${groupId}`);
            this.groups[groupId] = { version: groupInfo.version };
            console.log(`   ✅ Grupo ${groupId} versão ${groupInfo.version}`);
          } catch (err) {
            console.log(`   ❌ Erro ao obter info do grupo ${groupId}:`, err.message);
          }
        }
        this.saveJSON(this.groupsFile, this.groups);
        return true;
      } else if (result.had_pending_invites) {
        console.log("📩 Tinha convites pendentes, mas nenhum grupo pôde ser adicionado");
      } else {
        console.log("ℹ️ Nenhum convite de grupo pendente");
      }
      
      return false;
      
    } catch (err) {
      console.error("❌ Erro ao verificar grupos automáticos:", err.message);
      return false;
    }
  }

  async syncGroups() {
    try {
      console.log("🔄 Sincronizando grupos com o servidor...");
      
      const { groups } = await this.makeRequest(`${SERVER}/user_groups/${this.username}`);
      
      let updated = false;
      
      // Adicionar grupos que estão no servidor mas não localmente
      for (const [groupId, groupInfo] of Object.entries(groups)) {
        if (!this.groups[groupId]) {
          this.groups[groupId] = { version: groupInfo.version };
          console.log(`✅ Adicionado grupo localmente: ${groupId}`);
          updated = true;
        } else if (this.groups[groupId].version !== groupInfo.version) {
          this.groups[groupId].version = groupInfo.version;
          console.log(`🔄 Atualizada versão do grupo ${groupId} para v${groupInfo.version}`);
          updated = true;
        }
      }
      
      // Remover grupos que estão localmente mas não no servidor
      for (const groupId of Object.keys(this.groups)) {
        if (!groups[groupId]) {
          delete this.groups[groupId];
          console.log(`🗑️ Removido grupo localmente: ${groupId}`);
          updated = true;
        }
      }
      
      if (updated) {
        this.saveJSON(this.groupsFile, this.groups);
      }
      
      console.log("✅ Sincronização de grupos concluída");
      return true;
      
    } catch (err) {
      console.error("❌ Erro ao sincronizar grupos:", err.message);
      return false;
    }
  }

  async ensureSession(peer) {
    if (this.sessions[peer]) {
      const existingKey = Buffer.from(this.sessions[peer], "base64");
      if (existingKey.length === 32) {
        return existingKey;
      }
    }

    try {
      console.log(`\n🔑 Estabelecendo nova sessão com ${peer}...`);
      
      const { x25519_pub: peerPrekeyPub } = await this.makeRequest(`${SERVER}/prekey/${peer}`);

      const peerPublicKey = crypto.createPublicKey({
        key: Buffer.from(peerPrekeyPub, 'base64'),
        type: 'spki',
        format: 'der'
      });

      const localPrivateKey = this.getPrivateKey(this.prekey);

      const sharedSecret = crypto.diffieHellman({
        privateKey: localPrivateKey,
        publicKey: peerPublicKey
      });

      const sessionKey = this.deriveSessionKey(sharedSecret, peer);

      this.sessions[peer] = sessionKey.toString('base64');
      this.saveJSON(this.sessionFile, this.sessions);
      
      console.log(`✅ Sessão estabelecida com ${peer}`);
      return sessionKey;

    } catch (err) {
      console.error(`❌ Erro na sessão com ${peer}:`, err.message);
      return null;
    }
  }

  async send1to1(peer, msg) {
    try {
      const key = await this.ensureSession(peer);
      if (!key) {
        console.log(`❌ Não foi possível estabelecer sessão com ${peer}`);
        return;
      }

      const iv = crypto.randomBytes(12);//geração de valores aleátorios para manter a segurança
      console.log(`Valor aleatorio para usar na criptografia: ${iv}`);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);//criptografa a chave 'key'
      console.log(`Chave criptografada: ${cipher}`);
      
      let encrypted = cipher.update(msg, 'utf8', 'base64');
      encrypted += cipher.final('base64');
      const authTag = cipher.getAuthTag();

      const payload = {
        iv: iv.toString('base64'),
        tag: authTag.toString('base64'),
        data: encrypted,
        timestamp: Date.now()
      };

      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');

      await this.makeRequest(`${SERVER}/send_message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          to: peer, 
          from_user: this.username, 
          text : msg,
          payload: encodedPayload
        }),
      });
      
      console.log(`✅ Mensagem enviada para ${peer}`);
      
    } catch (err) {
      console.error("❌ Erro ao enviar mensagem:", err.message);
    }
  }

  async fetchMessages() {
    try {
      const { messages } = await this.makeRequest(`${SERVER}/fetch_messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: this.username }),
      });
      
      if (messages.length === 0) {
        return;
      }
      
      console.log(`\n📨 ${messages.length} mensagem(s) recebida(s):`);
      
      for (const m of messages) {
        await this.processMessage(m);
      }
      
    } catch (err) {
      if (!err.message.includes("HTTP")) {
        console.error("❌ Falha ao buscar mensagens:", err.message);
      }
    }
  }

  async processMessage(m) {
    try {
      const key = await this.ensureSession(m.from);
      if (!key) {
        console.log(`❌ Sessão não estabelecida com ${m.from}`);
        return;
      }

      const payloadStr = Buffer.from(m.payload, 'base64').toString('utf8');
      const payload = JSON.parse(payloadStr);
      
      const iv = Buffer.from(payload.iv, 'base64');
      const authTag = Buffer.from(payload.tag, 'base64');
      const encryptedData = payload.data;

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
      decrypted += decipher.final('utf8');
      
      console.log(`💬 ${m.from}: ${decrypted}`);
      
    } catch (err) {
      // console.error(`❌ Erro ao decifrar mensagem de ${m.from}:`, err.message);
      delete this.sessions[m.from];
      this.saveJSON(this.sessionFile, this.sessions);
    }
  }

  // =====================
  // GRUPOS AUTOMÁTICOS
  // =====================

  async createGroup(groupId, members) {
    try {
      console.log(`🔧 Criando grupo ${groupId} com membros: ${members.join(', ')}`);
      
      const result = await this.makeRequest(`${SERVER}/create_group`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          group_id: groupId,
          creator: this.username,
          members: members
        }),
      });
      
      console.log("✅ Grupo criado com sucesso!");
      console.log(`   👥 Membros adicionados: ${result.members.join(', ')}`);
      
      if (result.pending_members && result.pending_members.length > 0) {
        console.log(`   📩 Convites enviados para: ${result.pending_members.join(', ')}`);
        console.log("   Eles serão adicionados automaticamente ao se registrarem");
      }
      
      // Adicionar o grupo à lista loscal
      this.groups[groupId] = { version: result.version };
      this.saveJSON(this.groupsFile, this.groups);
      
      return true;
      
    } catch (err) {
      console.error("❌ Erro ao criar grupo:", err.message);
      return false;
    }
  }

  async forceAddToGroup(groupId, targetUser) {
    try {
      console.log(`🔧 Tentando adicionar forçadamente ${targetUser} ao grupo ${groupId}...`);
      
      const result = await this.makeRequest(`${SERVER}/force_add_to_group`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          group_id: groupId,
          user: targetUser
        }),
      });
      
      console.log(`✅ ${targetUser} adicionado ao grupo ${groupId}!`);
      console.log(`   Membros: ${result.members.join(', ')}`);
      console.log(`   Nova versão: ${result.version}`);
      
      return true;
      
    } catch (err) {
      console.error(`❌ Erro ao adicionar ${targetUser} ao grupo:`, err.message);
      return false;
    }
  }

  async leaveGroup(groupId) {
    try {
      const result = await this.makeRequest(`${SERVER}/group_remove_member`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          group_id: groupId,
          user_to_remove: this.username,
          removed_by: this.username
        }),
      });
      
      delete this.groups[groupId];
      this.saveJSON(this.groupsFile, this.groups);
      
      if (result.group_deleted) {
        console.log(`✅ Saiu do grupo '${groupId}' (grupo foi deletado)`);
      } else {
        console.log(`✅ Saiu do grupo '${groupId}'`);
        console.log(`   Membros restantes: ${result.members.join(', ')}`);
        console.log(`   Nova versão: ${result.version} (rekey automático)`);
      }
      
      return true;
      
    } catch (err) {
      console.error("❌ Erro ao sair do grupo:", err.message);
      return false;
    }
  }

  async sendGroupMessage(groupId, msg) {
    try {
      // Verificar se estamos no grupo
      if (!this.groups[groupId]) {
        console.log(`❌ Você não está no grupo ${groupId}. Use 'listgroups' para ver seus grupos.`);
        return;
      }

      const groupInfo = await this.makeRequest(`${SERVER}/group_info/${groupId}`);
      const localVersion = this.groups[groupId]?.version || 0;
      
      if (groupInfo.version !== localVersion) {
        console.log(`🔄 Grupo atualizado (v${localVersion} → v${groupInfo.version}), atualizando...`);
        this.groups[groupId] = { version: groupInfo.version };
        this.saveJSON(this.groupsFile, this.groups);
      }
      
      console.log(`📨 Cifrando mensagem para grupo ${groupId} (v${groupInfo.version})...`);
      
      const members = groupInfo.members.filter(m => m !== this.username);
      
      let successCount = 0;
      const failedMembers = [];
      
      for (const member of members) {
        const key = await this.ensureSession(member);
        if (!key) {
          failedMembers.push(member);
          continue;
        }

        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        
        let encrypted = cipher.update(msg, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        const authTag = cipher.getAuthTag();

        const payload = {
          iv: iv.toString('base64'),
          tag: authTag.toString('base64'),
          data: encrypted,
          for_member: member,
          group_version: groupInfo.version,
          timestamp: Date.now()
        };

        const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');

        await this.makeRequest(`${SERVER}/send_group_message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            group_id: groupId,
            from_user: this.username,
            payload: encodedPayload,
            meta: { encrypted_for: member, group_version: groupInfo.version }
          }),
        });
        
        successCount++;
      }
      
      if (successCount > 0) {
        console.log(`✅ Mensagem enviada para grupo ${groupId} (${successCount}/${members.length} membros)`);
      }
      
      if (failedMembers.length > 0) {
        console.log(`❌ Falha com: ${failedMembers.join(', ')}`);
      }
      
    } catch (err) {
      if (err.message.includes("403")) {
        console.log(`❌ Você não está mais no grupo ${groupId}. Removendo da lista local...`);
        delete this.groups[groupId];
        this.saveJSON(this.groupsFile, this.groups);
      } else {
        console.error("❌ Erro ao enviar mensagem para grupo:", err.message);
      }
    }
  }

  async fetchGroupMessages(groupId) {
    try {
      // Verificar primeiro se estamos no grupo LOCALMENTE
      if (!this.groups[groupId]) {
        return; // Silenciosamente ignora grupos que não estão na lista local
      }

      console.log(`🔍 Buscando mensagens do grupo ${groupId}...`);
      
      const { messages, current_version, group_members } = await this.makeRequest(`${SERVER}/fetch_group_messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          group_id: groupId,
          user: this.username 
        }),
      });
      
      console.log(`✅ Sucesso ao buscar mensagens do grupo ${groupId}`);
      console.log(`   Membros do grupo: ${group_members.join(', ')}`);
      
      // Atualizar versão local se necessário
      if (this.groups[groupId] && this.groups[groupId].version !== current_version) {
        console.log(`🔄 Grupo atualizado para v${current_version}`);
        this.groups[groupId].version = current_version;
        this.saveJSON(this.groupsFile, this.groups);
      }
      
      if (messages.length === 0) {
        return;
      }
      
      console.log(`\n📨 ${messages.length} mensagem(s) do grupo ${groupId}:`);
      
      for (const m of messages) {
        await this.processGroupMessage(m, groupId);
      }
      
    } catch (err) {
      if (err.message.includes("403")) {
        console.log(`❌ Você não está mais no grupo ${groupId}. Removendo da lista local...`);
        delete this.groups[groupId];
        this.saveJSON(this.groupsFile, this.groups);
      } else if (!err.message.includes("HTTP")) {
        console.error("❌ Falha ao buscar mensagens do grupo:", err.message);
      }
    }
  }

  async fetchGroupMessagesSilent(groupId) {
    try {
      // Verificar primeiro se estamos no grupo LOCALMENTE
      if (!this.groups[groupId]) {
        return;
      }

      const { messages, current_version } = await this.makeRequest(`${SERVER}/fetch_group_messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          group_id: groupId,
          user: this.username 
        }),
      });
    }catch(err){
      console.log("Deu ruim")
    }
  }
}
  // Atualizar versão local silenciosamente

// client.js (Adicione no final do arquivo)
// =====================================
// LÓGICA DE INICIALIZAÇÃO E MENU
// =====================================

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const showMenu = () => {
    console.log("\n=====================================");
    console.log(` Usuário: ${client.username} | Comandos:`);
    console.log("=====================================");
    console.log(" register - Registra o usuário no servidor.");
    console.log(" uploadkey  - Envia a prekey para o servidor.");
    console.log(" send <user> <msg> - Envia mensagem 1-para-1.");
    console.log(" fetch  - Busca mensagens privadas.");
    console.log(" create <group> <user1,user2,...> - Cria grupo.");
    console.log(" sync - Sincroniza lista de grupos.");
    console.log(" sendg <group> <msg> - Envia mensagem para grupo.");
    console.log(" fetchg <group> - Busca mensagens de um grupo.");
    console.log(" exit - Sair.");
    rl.prompt();
};

// Funções de inicialização
const startClient = () => {
    rl.question("Qual seu nome de usuário? ", async (answer) => {
        if (!answer || answer.trim() === '') {
            console.log("Nome de usuário inválido. Saindo.");
            rl.close();
            return;
        }

        global.client = new Client(answer.trim());
        console.log(`\nBem-vindo(a), ${client.username}! Digite 'menu' para comandos.`);
        
        // Tenta checar se há convites pendentes ao iniciar
        await client.checkAutoJoin();

        rl.on('line', async (input) => {
            const parts = input.trim().split(/\s+/);
            const command = parts[0].toLowerCase();
            
            switch (command) {
                case 'menu':
                    showMenu();
                    break;
                case 'register':
                    await client.register();
                    break;
                case 'uploadkey':
                    await client.uploadPrekey();
                    break;
                case 'send':
                    if (parts.length < 3) {
                        console.log("Uso: formato errado, digite da seguinte forma: send <destinatario> <mensagem>");
                    } else {
                        const peer = parts[1];
                        const msg = parts.slice(2).join(' ');
                        await client.send1to1(peer, msg);
                    }
                    break;
                case 'fetch':
                    await client.fetchMessages();
                    break;
                case 'create':
                    if (parts.length < 3) {
                        console.log("Uso: create <group_id> <membro1,membro2,...>");
                    } else {
                        const groupId = parts[1];
                        const members = parts[2].split(',');
                        await client.createGroup(groupId, members);
                    }
                    break;
                case 'sync':
                    await client.syncGroups();
                    break;
                case 'sendg':
                    if (parts.length < 3) {
                        console.log("Uso: sendg <group_id> <mensagem>");
                    } else {
                        const groupId = parts[1];
                        const msg = parts.slice(2).join(' ');
                        await client.sendGroupMessage(groupId, msg);
                    }
                    break;
                case 'fetchg':
                    if (parts.length < 2) {
                        console.log("Uso: fetchg <group_id>");
                    } else {
                        const groupId = parts[1];
                        await client.fetchGroupMessages(groupId);
                    }
                    break;
                case 'exit':
                    rl.close();
                    break;
                default:
                    console.log(`Comando '${command}' não reconhecido. Digite 'menu' para ver a lista.`);
                    break;
            }
            rl.prompt();
        }).on('close', () => {
            console.log('\nCliente encerrado.');
            process.exit(0);
        });
        showMenu();
    });
};

startClient();