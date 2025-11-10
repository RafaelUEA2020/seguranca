
import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";

const app = express();
app.use(bodyParser.json());

let users = {}; // {user: {identity_pub, registered_at}}
let user_prekeys = {}; // {user: x25519_pub}
let user_queues = {}; // {user: [messages]}
let groups = {}; // {group_id: {creator, members: [], pending_members: [], version}}
let group_invites = {}; // {user: [group_ids]}

// MIDDLEWARE DE LOG
app.use((req, res, next) => {
    console.log(`\n🌐 ${req.method} ${req.path}`, req.body || '');
    next();
});

// =====================
// ROTAS DE USUÁRIO
// =====================

app.post("/register", (req, res) => {
    const { user, identity_pub } = req.body;

    if (!user || !identity_pub) {
        return res.status(400).json({ error: "user e identity_pub são obrigatórios" });
    }

    if (users[user]) {
        return res.status(400).json({ error: "Usuário já registrado" });
    }

    users[user] = {
        identity_pub,
        registered_at: new Date().toISOString()
    };

    user_queues[user] = [];

    console.log(`✅ Usuário registrado: ${user}`);

    // Verificar se há convites pendentes para este usuário
    const autoJoinedGroups = [];
    if (group_invites[user]) {
        console.log(`📩 ${user} tem ${group_invites[user].length} convites pendentes`);
        
        for (const groupId of group_invites[user]) {
            if (groups[groupId] && groups[groupId].pending_members.includes(user)) {
                // Adicionar usuário ao grupo
                groups[groupId].members.push(user);
                groups[groupId].pending_members = groups[groupId].pending_members.filter(m => m !== user);
                groups[groupId].version += 1; // Rekey
                
                autoJoinedGroups.push(groupId);
                console.log(`✅ ${user} adicionado automaticamente ao grupo ${groupId}`);
            }
        }
        
        // Limpar convites processados
        delete group_invites[user];
    }

    res.json({ 
        success: true, 
        auto_joined_groups: autoJoinedGroups 
    });
});

app.post("/upload_prekey", (req, res) => {
    const { user, x25519_pub } = req.body;

    if (!users[user]) {
        return res.status(400).json({ error: "Usuário não registrado" });
    }

    user_prekeys[user] = x25519_pub;
    console.log(`✅ Prekey atualizada para: ${user}`);

    res.json({ success: true });
});

app.get("/prekey/:user", (req, res) => {
    const user = req.params.user;

    if (!user_prekeys[user]) {
        return res.status(404).json({ error: "Prekey não encontrada" });
    }

    res.json({ x25519_pub: user_prekeys[user] });
});

// =====================
// MENSAGENS PRIVADAS
// =====================

app.post("/send_message", (req, res) => {
    const { to, from_user ,payload } = req.body;

    if (!users[to] || !user_prekeys[to]) {
        return res.status(400).json({ error: "Destinatário não registrado ou sem prekey" });
    }

    if (!user_queues[to]) {
        user_queues[to] = [];
    }

     message = {
        from: from_user,
        encrypted_message: payload,
        timestamp: Date.now()
    };

    user_queues[to].push(message);
    //console.log(message)
    console.log(`✅ Mensagem privada de ${from_user} para ${to}`);

    res.json({ success: true });
});

app.post("/fetch_messages", (req, res) => {
    const { user } = req.body;

    if (!user_queues[user]) {
        return res.json({ messages: [] });
    }

    const messages = user_queues[user];

    console.log(`📨 Entregando ${messages.length} mensagens para ${user}`);
    
    res.json({ messages });
    console.log({user_queues});
    //user_queues[user] = []; // Limpar fila
});

app.post("/clear_chat", (req, res) => {
    const { user} = req.body;
    user_queues[user] = [];
});


// =====================
// GRUPOS - VERSÃO CORRIGIDA
// =====================

app.post("/create_group", (req, res) => {
    const { group_id, creator, members } = req.body;

    if (groups[group_id]) {
        return res.status(400).json({ error: "Grupo já existe" });
    }

    if (!users[creator]) {
        return res.status(400).json({ error: "Criador não registrado" });
    }

    // Verificar membros válidos
    const validMembers = [creator]; // Criador sempre é membro
    const pendingMembers = [];

    members.forEach(member => {
        if (users[member]) {
            validMembers.push(member);
        } else {
            pendingMembers.push(member);
            // Adicionar à lista de convites pendentes
            if (!group_invites[member]) {
                group_invites[member] = [];
            }
            group_invites[member].push(group_id);
        }
    });

    groups[group_id] = {
        creator: creator,
        members: validMembers,
        pending_members: pendingMembers,
        version: 1,
        created_at: new Date().toISOString()
    };

    console.log(`✅ Grupo criado: ${group_id}`);
    console.log(`   👥 Membros: ${validMembers.join(', ')}`);
    if (pendingMembers.length > 0) {
        console.log(`   📩 Pendentes: ${pendingMembers.join(', ')}`);
    }

    res.json({
        success: true,
        members: validMembers,
        pending_members: pendingMembers,
        version: 1
    });
});

app.post("/force_add_to_group", (req, res) => {
    const { group_id, user } = req.body;

    if (!groups[group_id]) {
        return res.status(404).json({ error: "Grupo não encontrado" });
    }

    const group = groups[group_id];

    if (group.members.includes(user)) {
        return res.status(400).json({ error: "Usuário já está no grupo" });
    }

    // Adicionar usuário
    group.members.push(user);
    
    // Remover de pendentes se estiver lá
    group.pending_members = group.pending_members.filter(m => m !== user);
    
    // Incrementar versão para forçar rekey
    group.version += 1;

    console.log(`✅ ${user} adicionado ao grupo ${group_id}`);
    console.log(`   👥 Membros: ${group.members.join(', ')}`);
    console.log(`   🔢 Nova versão: ${group.version}`);

    res.json({
        success: true,
        members: group.members,
        version: group.version
    });
});

app.post("/group_remove_member", (req, res) => {
    const { group_id, user_to_remove, removed_by } = req.body;

    if (!groups[group_id]) {
        return res.status(404).json({ error: "Grupo não encontrado" });
    }

    const group = groups[group_id];

    // Apenas o criador ou o próprio usuário pode remover
    if (removed_by !== group.creator && removed_by !== user_to_remove) {
        return res.status(403).json({ error: "Sem permissão para remover membro" });
    }

    // Remover usuário
    group.members = group.members.filter(m => m !== user_to_remove);
    group.pending_members = group.pending_members.filter(m => m !== user_to_remove);
    
    let groupDeleted = false;

    // Se não há mais membros, deletar grupo
    if (group.members.length === 0) {
        delete groups[group_id];
        groupDeleted = true;
        console.log(`🗑️ Grupo ${group_id} deletado (sem membros)`);
    } else {
        // Se o criador saiu, transferir criação para outro membro
        if (user_to_remove === group.creator) {
            group.creator = group.members[0];
            console.log(`👑 Criador transferido para: ${group.creator}`);
        }
        
        // Rekey - incrementar versão
        group.version += 1;
        
        console.log(`✅ ${user_to_remove} removido do grupo ${group_id}`);
        console.log(`   👥 Membros restantes: ${group.members.join(', ')}`);
        console.log(`   🔢 Nova versão: ${group.version}`);
    }

    res.json({
        success: true,
        group_deleted: groupDeleted,
        members: groupDeleted ? [] : group.members,
        version: groupDeleted ? 0 : group.version,
        new_creator: groupDeleted ? null : group.creator
    });
});

// =====================
// MENSAGENS DE GRUPO - VERSÃO CORRIGIDA
// =====================

app.post("/send_group_message", (req, res) => {
    const { group_id, from_user, payload, meta } = req.body;
    
    console.log(`\n📨 MENSAGEM DE GRUPO RECEBIDA:`);
    console.log(`   Grupo: ${group_id}`);
    console.log(`   De: ${from_user}`);
    console.log(`   Versão: ${meta?.group_version}`);
    
    // VERIFICAR SE O GRUPO EXISTE
    if (!groups[group_id]) {
        console.log(`❌ Grupo ${group_id} não existe`);
        return res.status(404).json({ error: "Grupo não encontrado" });
    }
    
    const group = groups[group_id];
    
    // VERIFICAR SE O REMETENTE É MEMBRO
    if (!group.members.includes(from_user)) {
        console.log(`❌ ${from_user} não é membro do grupo ${group_id}`);
        return res.status(403).json({ error: "Não é membro do grupo" });
    }
    
    console.log(`   👥 Membros do grupo: ${group.members.join(', ')}`);
    
    let deliveredCount = 0;
    const failedDeliveries = [];
    const successDeliveries = [];
    
    // ENTREGAR PARA TODOS OS MEMBROS (EXCETO O REMETENTE)
    group.members.forEach(member => {
        if (member === from_user) {
            console.log(`   ⏩ Pulando remetente: ${member}`);
            return; // Não enviar para si mesmo
        }
        
        // VERIFICAR SE O MEMBRO EXISTE
        if (!users[member]) {
            console.log(`   ❌ Usuário ${member} não registrado`);
            failedDeliveries.push(member);
            return;
        }
        
        // VERIFICAR SE O MEMBRO TEM PREKEY (está ativo)
        if (!user_prekeys[member]) {
            console.log(`   ❌ Usuário ${member} não tem prekey registrada`);
            failedDeliveries.push(member);
            return;
        }
        
        // VERIFICAR SE TEM FILA DE MENSAGENS
        if (!user_queues[member]) {
            user_queues[member] = [];
        }
        
        const message = {
            from: from_user,
            payload: payload,
            group_id: group_id,
            timestamp: Date.now(),
            meta: meta
        };
        
        user_queues[member].push(message);
        deliveredCount++;
        successDeliveries.push(member);
        console.log(`   ✅ Entregue para: ${member}`);
    });
    
    console.log(`\n📊 RESUMO DE ENTREGA:`);
    console.log(`   ✅ Entregues: ${deliveredCount}`);
    console.log(`   ❌ Falhas: ${failedDeliveries.length}`);
    console.log(`   👥 Total de membros (exceto remetente): ${group.members.length - 1}`);
    
    if (successDeliveries.length > 0) {
        console.log(`   📋 Sucesso: ${successDeliveries.join(', ')}`);
    }
    
    if (failedDeliveries.length > 0) {
        console.log(`   🗑️ Falhas: ${failedDeliveries.join(', ')}`);
    }
    
    res.json({
        success: true,
        delivered_to: deliveredCount,
        total_members: group.members.length - 1, // excluindo remetente
        failed_deliveries: failedDeliveries,
        success_deliveries: successDeliveries,
        group_version: group.version
    });
});

app.post("/fetch_group_messages", (req, res) => {
    const { group_id, user } = req.body;

    if (!groups[group_id]) {
        return res.status(404).json({ error: "Grupo não encontrado" });
    }

    const group = groups[group_id];

    // Verificar se o usuário é membro
    if (!group.members.includes(user)) {
        return res.status(403).json({ error: "Não é membro do grupo" });
    }

    if (!user_queues[user]) {
        return res.json({ 
            messages: [], 
            current_version: group.version,
            group_members: group.members 
        });
    }

    // Filtrar apenas mensagens deste grupo
    const groupMessages = user_queues[user].filter(msg => msg.group_id === group_id);
    
    // Remover mensagens do grupo da fila do usuário
    user_queues[user] = user_queues[user].filter(msg => msg.group_id !== group_id);

    console.log(`📨 Entregando ${groupMessages.length} mensagens do grupo ${group_id} para ${user}`);

    res.json({ 
        messages: groupMessages,
        current_version: group.version,
        group_members: group.members
    });
});

// =====================
// CONVITES AUTOMÁTICOS
// =====================

app.post("/auto_join_groups", (req, res) => {
    const { user } = req.body;

    if (!users[user]) {
        return res.status(400).json({ error: "Usuário não registrado" });
    }

    const joinedGroups = [];
    let hadPendingInvites = false;

    if (group_invites[user]) {
        hadPendingInvites = true;
        console.log(`📩 ${user} tem ${group_invites[user].length} convites pendentes`);
        
        for (const groupId of group_invites[user]) {
            if (groups[groupId] && groups[groupId].pending_members.includes(user)) {
                // Adicionar usuário ao grupo
                groups[groupId].members.push(user);
                groups[groupId].pending_members = groups[groupId].pending_members.filter(m => m !== user);
                groups[groupId].version += 1; // Rekey
                
                joinedGroups.push(groupId);
                console.log(`✅ ${user} adicionado automaticamente ao grupo ${groupId}`);
            }
        }
        
        // Limpar convites processados
        delete group_invites[user];
    }

    res.json({ 
        joined_groups: joinedGroups,
        had_pending_invites: hadPendingInvites
    });
});

// =====================
// CONSULTAS
// =====================

app.get("/group_info/:group_id", (req, res) => {
    const group_id = req.params.group_id;

    if (!groups[group_id]) {
        return res.status(404).json({ error: "Grupo não encontrado" });
    }

    res.json(groups[group_id]);
});

app.get("/user_groups/:user", (req, res) => {
    const user = req.params.user;
    const userGroups = {};

    Object.keys(groups).forEach(groupId => {
        const group = groups[groupId];
        if (group.members.includes(user)) {
            userGroups[groupId] = {
                creator: group.creator,
                members: group.members,
                pending_members: group.pending_members,
                version: group.version
            };
        }
    });

    res.json({ groups: userGroups });
});

// =====================
// DEBUG E STATUS
// =====================

app.get("/debug/user_groups/:user", (req, res) => {
    const user = req.params.user;
    const allGroups = {};
    let totalGroupsUserIsMember = 0;

    Object.keys(groups).forEach(groupId => {
        const group = groups[groupId];
        allGroups[groupId] = {
            creator: group.creator,
            members: group.members,
            pending_members: group.pending_members,
            version: group.version,
            user_is_member: group.members.includes(user),
            user_is_pending: group.pending_members.includes(user)
        };

        if (group.members.includes(user)) {
            totalGroupsUserIsMember++;
        }
    });

    res.json({
        groups: allGroups,
        total_groups_user_is_member: totalGroupsUserIsMember,
        total_groups: Object.keys(groups).length
    });
});

app.get("/debug/queues", (req, res) => {
    const queueStatus = {};
    
    Object.keys(user_queues).forEach(user => {
        queueStatus[user] = {
            message_count: user_queues[user].length,
            has_prekey: !!user_prekeys[user],
            is_registered: !!users[user],
            messages: user_queues[user].map(msg => ({
                from: msg.from,
                group_id: msg.group_id || 'private',
                timestamp: new Date(msg.timestamp).toISOString()
            }))
        };
    });

    res.json(queueStatus);
});

app.get("/debug/groups", (req, res) => {
    res.json({
        groups: groups,
        total_groups: Object.keys(groups).length,
        total_users: Object.keys(users).length,
        total_with_prekeys: Object.keys(user_prekeys).length
    });
});

app.get("/status", (req, res) => {
    res.json({
        server: "online",
        users: Object.keys(users).length,
        groups: Object.keys(groups).length,
        active_queues: Object.keys(user_queues).length,
        pending_invites: Object.keys(group_invites).length
    });
});

// =====================
// INICIALIZAÇÃO
// =====================

const PORT = 8000;

app.listen(PORT, () => {
    console.log(`\n🚀 Servidor rodando na porta ${PORT}`);
    console.log("=====================================");
    console.log("📞 Endpoints disponíveis:");
    console.log("   POST /register");
    console.log("   POST /upload_prekey");
    console.log("   GET  /prekey/:user");
    console.log("   POST /send_message");
    console.log("   POST /fetch_messages");
    console.log("   POST /create_group");
    console.log("   POST /force_add_to_group");
    console.log("   POST /group_remove_member");
    console.log("   POST /send_group_message");
    console.log("   POST /fetch_group_messages");
    console.log("   POST /auto_join_groups");
    console.log("   GET  /group_info/:group_id");
    console.log("   GET  /user_groups/:user");
    console.log("   GET  /status");
    console.log("   GET  /debug/queues");
    console.log("=====================================\n");
});

// Export para testes
export default app;