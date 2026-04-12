// import "jsr:@supabase/functions-js/edge-runtime.d.ts"
// import { createClient } from "jsr:@supabase/supabase-js@2"

// const VERIFY_TOKEN = "virtual_barber_webhook_2026"

// const supabase = createClient(
//   Deno.env.get("SUPABASE_URL")!,
//   Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
// )

// Deno.serve(async (req) => {
//   const url = new URL(req.url)

//   if (req.method === "GET") {
//     const mode = url.searchParams.get("hub.mode")
//     const token = url.searchParams.get("hub.verify_token")
//     const challenge = url.searchParams.get("hub.challenge")
//     if (mode === "subscribe" && token === VERIFY_TOKEN) {
//       console.log("Webhook verificado com sucesso!")
//       return new Response(challenge, { status: 200 })
//     }
//     return new Response("Token invalido", { status: 403 })
//   }

//   if (req.method === "POST") {
//     try {
//       const body = await req.json()
//       const value = body.entry?.[0]?.changes?.[0]?.value

//       if (value?.messages?.length > 0) {
//         const msg = value.messages[0]

//         const from = msg.from
//         const phoneNumberId = value.metadata.phone_number_id
        
//         if (msg.type !== "text") {
//           console.log("Mensagem ignorada - tipo:", msg.type)
//           await enviarWhatsApp(phoneNumberId, from, "Desculpe, ainda não consigo processar esse tipo de mensagem. Por favor, envie sua dúvida em formato de texto para que eu possa ajudá-lo.")
//           return new Response("OK", { status: 200 })
//         }

//         const texto = msg.text.body
//         const nomeCliente = value.contacts?.[0]?.profile?.name || "Cliente"

//         console.log(`Mensagem de ${nomeCliente} (${from}): ${texto}`)

//         const conversa = await getOuCriarConversa(phoneNumberId, from)
//         console.log(`Conversa: ${conversa.id} | Msgs anteriores: ${conversa.historic.length}`)

//         const MENSAGENS_RETIDAS = 10
//         const historicoLimitado = conversa.historic.slice(-MENSAGENS_RETIDAS)
//         const historicoAtualizado = [
//           ...historicoLimitado,
//           { role: "user", content: texto }
//         ]

//         const respostaHaiku = await chamarHaiku(historicoAtualizado, nomeCliente)
//         console.log("Haiku respondeu:", respostaHaiku)

//         historicoAtualizado.push({ role: "assistant", content: respostaHaiku })

//         let novoStatus = "em_andamento"
//         if (respostaHaiku.includes("AGENDAMENTO_CONFIRMADO:")) {
//           const jsonMatch = respostaHaiku.match(/AGENDAMENTO_CONFIRMADO:(\{.*\})/)
//           if (jsonMatch) {
//             const agendamento = JSON.parse(jsonMatch[1])
//             console.log("AGENDAMENTO CRIADO:", JSON.stringify(agendamento))
//             novoStatus = "concluida"
//           }
//         }

//         await atualizarConversa(conversa.id, historicoAtualizado, novoStatus)
//         await enviarWhatsApp(phoneNumberId, from, respostaHaiku)
//         console.log(`Resposta enviada para ${from}`)
//       }

//       if (value?.statuses?.length > 0) {
//         const status = value.statuses[0]
//         console.log(`Status: ${status.status} para ${status.recipient_id}`)
//       }

//       return new Response("OK", { status: 200 })
//     } catch (error) {
//       console.error("Erro ao processar webhook:", error)
//       return new Response("OK", { status: 200 })
//     }
//   }

//   return new Response("Metodo nao suportado", { status: 405 })
// })


// async function getOuCriarConversa(phoneNumberId: string, clienteNumero: string) {
//   const { data: existente } = await supabase
//     .from("conversations_chatbot")
//     .select("*")
//     .eq("barbershop_phone_number_id", phoneNumberId)
//     .eq("client_phone_number_id", clienteNumero)
//     .eq("status", "em_andamento")
//     .order("updated_at", { ascending: false })
//     .limit(1)
//     .single()

//   if (existente) return existente

//   const { data: nova, error } = await supabase
//     .from("conversations_chatbot")
//     .insert({
//       barbershop_phone_number_id: phoneNumberId,
//       client_phone_number_id: clienteNumero,
//       historic: [],
//       status: "em_andamento",
//     })
//     .select()
//     .single()

//   if (error) {
//     console.error("Erro ao criar conversa:", error)
//     throw error
//   }
//   return nova
// }


// async function atualizarConversa(
//   conversaId: string,
//   historico: Array<{ role: string; content: string }>,
//   status: string
// ) {
//   const { error } = await supabase
//     .from("conversations_chatbot")
//     .update({
//       historic: historico,
//       status: status,
//       updated_at: new Date().toISOString(),
//     })
//     .eq("id", conversaId)

//   if (error) console.error("Erro ao atualizar conversa:", error)
// }


// async function chamarHaiku(
//   historico: Array<{ role: string; content: string }>,
//   nomeCliente: string
// ): Promise<string> {
//   const apiKey = Deno.env.get("ANTHROPIC_API_KEY")

//   if (!apiKey) {
//     console.error("ANTHROPIC_API_KEY não configurada!")
//     return "Desculpe, estou com um problema técnico. Tente novamente em alguns minutos."
//   }

//   const MAX_HISTORICO = 10
//   const historicoLimitado = historico.slice(-MAX_HISTORICO)

//   // =====================================================
//   // SYSTEM PROMPT com cache_control explícito
//   // Bloco único com +2048 tokens para ativar o cache
//   // Primeira chamada: cache write (1.25x do preço base)
//   // Chamadas seguintes em 5min: cache read (0.1x = 90% off)
//   // =====================================================
//   const systemPrompt = [
//     {
//       type: "text",
//       text: `Você é o assistente virtual de agendamento da barbearia Virtual Barber, um sistema inteligente de agendamento via WhatsApp.
//         Seu único objetivo é ajudar os clientes da barbearia a agendar serviços de forma rápida, eficiente e amigável.
//         Você deve se comportar como um atendente real: simpático, direto, informal e em português brasileiro natural.
//         Use emojis com moderação para deixar a conversa mais leve e humana, mas sem exagero.

//         O nome do cliente nesta conversa é: ${nomeCliente}

//         === INFORMAÇÕES DA BARBEARIA ===
//         Nome: Virtual Barber
//         Endereço: Rua Exemplo, 123 - Porto Alegre, RS
//         Telefone: (51) 99647-2696
//         Horário de funcionamento: Segunda a Sábado, das 9:00 às 19:00
//         Domingo: Fechado

//         === SERVIÇOS DISPONÍVEIS ===
//         1. Corte de cabelo - R$45,00 (duração: 30 minutos)
//           Inclui: lavagem, corte com tesoura ou máquina, finalização com secador
//           Estilos: degradê, social, americano, moicano, undercut e outros

//         2. Barba - R$30,00 (duração: 20 minutos)
//           Inclui: aparar barba com máquina ou navalha, alinhamento, toalha quente, hidratação

//         3. Corte + Barba - R$65,00 (duração: 45 minutos)
//           Combo completo com desconto: corte de cabelo + barba com todos os serviços inclusos

//         4. Platinado - R$120,00 (duração: 60 minutos)
//           Inclui: descoloração completa, tonalização, tratamento capilar pós-química
//           Importante: pode ser necessário mais de uma sessão dependendo do cabelo

//         === BARBEIROS DISPONÍVEIS ===
//         1. Carlos - Especialista em cortes modernos, degradê e design capilar
//           Trabalha de segunda a sexta, das 9:00 às 18:00

//         2. Rafael - Especialista em barba, cortes clássicos e platinados
//           Trabalha de terça a sábado, das 10:00 às 19:00

//         === HORÁRIOS LIVRES HOJE ===
//         Carlos: 10:00, 11:00, 14:00, 15:00, 16:00
//         Rafael: 10:00, 11:00, 14:00, 15:00, 16:00`
//     },
//     {  
//       type: "text",
//       text: `EXEMPLOS RÁPIDOS:
//         Direto: "Quero corte Carlos 14h" → "Corte c/ Carlos hoje 14h R$45. Confirma?" → "Sim" → "Agendado! 💈 AGENDAMENTO_CONFIRMADO:{...}"
//         Gradual: "Oi" → apresentar serviços → coletar dados → confirmar
//         Fora escopo: redirecionar telefone
//         Horário cheio: listar alternativas

//         SITUAÇÕES ESPECIAIS: Áudio/imagem → "Só leio texto". Emoji → perguntar como ajuda. Agradecimento → responder breve. Cancelar → "Sem problema!". Desconto → preços fixos, mas combo tem R$10 off. Qual barbeiro melhor? → ambos excelentes, preferência de estilo? Outro idioma → responder em PT. Mudar horário antes de confirmar → ok. Estacionamento/WiFi → ligar pra barbearia.

//         PERSONALIDADE: Jovem, descontraído, profissional. Gírias leves RS (bah, tchê) com moderação. É colorado torce pro Inter (só se perguntarem). Não seja robótico.

//         LEMBRETE: Colete serviço, barbeiro, data, horário rápido e natural. Menos mensagens = melhor atendimento. Trate cliente como amigo.`    }
//   ]

//   try {
//     const response = await fetch("https://api.anthropic.com/v1/messages", {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         "x-api-key": apiKey,
//         "anthropic-version": "2023-06-01",
//       },
//       body: JSON.stringify({
//         model: "claude-haiku-4-5-20251001",
//         max_tokens: 300,
//         cache_control: { type: "ephemeral" },
//         system: systemPrompt,
//         messages: historicoLimitado,
//       }),
//     })

//     const data = await response.json()

//     if (data.usage) {
//       const cacheWrite = data.usage.cache_creation_input_tokens || 0
//       const cacheRead = data.usage.cache_read_input_tokens || 0
//       const input = data.usage.input_tokens || 0
//       const output = data.usage.output_tokens || 0
//       const cached = cacheRead > 0 ? "CACHE HIT" : cacheWrite > 0 ? "CACHE WRITE" : "NO CACHE"
//       console.log(`[${cached}] input: ${input}, output: ${output}, cache_write: ${cacheWrite}, cache_read: ${cacheRead}`)
//     }

//     if (data.content && data.content[0] && data.content[0].text) {
//       return data.content[0].text
//     }

//     console.error("Resposta inesperada do Haiku:", JSON.stringify(data))
//     return "Desculpe, tive um problema ao processar sua mensagem. Pode repetir?"

//   } catch (error) {
//     console.error("Erro ao chamar Haiku:", error)
//     return "Desculpe, estou com dificuldade para processar sua mensagem. Tente novamente em alguns segundos."
//   }
// }


// async function enviarWhatsApp(
//   phoneNumberId: string,
//   to: string,
//   texto: string
// ): Promise<void> {
//   const token = Deno.env.get("WHATSAPP_TOKEN")

//   if (!token) {
//     console.error("WHATSAPP_TOKEN não configurado!")
//     return
//   }

//   const textoLimpo = texto
//     .replace(/AGENDAMENTO_CONFIRMADO:\{.*\}/s, "")
//     .trim()

//   try {
//     const response = await fetch(
//       `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
//       {
//         method: "POST",
//         headers: {
//           "Authorization": `Bearer ${token}`,
//           "Content-Type": "application/json",
//         },
//         body: JSON.stringify({
//           messaging_product: "whatsapp",
//           to: to,
//           type: "text",
//           text: { body: textoLimpo },
//         }),
//       }
//     )

//     const result = await response.json()

//     if (result.error) {
//       console.error("Erro ao enviar WhatsApp:", JSON.stringify(result.error))
//     }
//   } catch (error) {
//     console.error("Erro na requisição WhatsApp:", error)
//   }
// }


import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const VERIFY_TOKEN = "virtual_barber_webhook_2026"

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
)

// ============================================
// TIPOS
// ============================================
interface DadosBarbearia {
  barbershop_id: string
  barbershop_name: string
  phone: string
  address: string
  servicos: Array<{
    id: string
    name: string
    price: number
    duration_min: number
  }>
  barbeiros: Array<{
    id: string
    name: string
    description: string
    availability: Array<{
      day_of_week: number
      starts_at: string
      ends_at: string
      is_day_off: boolean
    }>
    services: string[] // IDs dos serviços que faz
  }>
  hash: string
  atualizado_em: string
}

interface EstadoColeta {
  etapa: 'inicio' | 'servico' | 'dia' | 'barbeiro' | 'horario' | 'confirmacao'
  dados_barbearia?: DadosBarbearia
  servico_escolhido?: { id: string; name: string; price: number; duration_min: number }
  dia_escolhido?: string // YYYY-MM-DD
  dia_semana?: number // 0-6
  barbeiros_disponiveis?: Array<{ id: string; name: string; description: string }>
  barbeiro_escolhido?: { id: string; name: string }
  horarios_disponiveis?: string[]
  horario_escolhido?: string
}

// ============================================
// SERVIDOR PRINCIPAL
// ============================================
Deno.serve(async (req) => {
  const url = new URL(req.url)

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode")
    const token = url.searchParams.get("hub.verify_token")
    const challenge = url.searchParams.get("hub.challenge")
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verificado com sucesso!")
      return new Response(challenge, { status: 200 })
    }
    return new Response("Token invalido", { status: 403 })
  }

  if (req.method === "POST") {
    try {
      const body = await req.json()
      const value = body.entry?.[0]?.changes?.[0]?.value

      if (value?.messages?.length > 0) {
        const msg = value.messages[0]
        const from = msg.from
        const phoneNumberId = value.metadata?.phone_number_id || value.phone_number_id

        if (msg.type !== "text") {
          await enviarWhatsApp(phoneNumberId, from, "Desculpe, ainda não consigo processar esse tipo de mensagem...")
          return new Response("OK", { status: 200 })
        }

        const texto = msg.text.body
        const nomeCliente = value.contacts?.[0]?.profile?.name || "Cliente"

        console.log(`Mensagem de ${nomeCliente} (${from}): ${texto}`)

        // Busca ou cria conversa
        let conversa = await getOuCriarConversa(phoneNumberId, from, nomeCliente)
        
        // Se é nova conversa (histórico vazio), inicializa com dados da barbearia
        let dadosBarbearia: DadosBarbearia | undefined = undefined
        let precisaCacheWrite = true
        
        if ((conversa.historic as any[]).length === 0) {
          console.log("Nova conversa - inicializando dados da barbearia...")
          const inicializacao = await inicializarConversa(
            phoneNumberId,
            conversa.id,
            nomeCliente
          )
          dadosBarbearia = inicializacao.dadosBarbearia
          precisaCacheWrite = inicializacao.precisaCacheWrite
          conversa = inicializacao.conversaAtualizada
        } else {
          // Recupera dados do estado da conversa
          const estado = (conversa.historic as any[]).find(
            (h: any) => h.role === 'system' && h.tipo === 'dados_barbearia'
          )?.content as DadosBarbearia | undefined
          
          if (estado) {
            dadosBarbearia = estado
            precisaCacheWrite = false // Já foi cacheado na primeira mensagem
          }
        }

        // Processa mensagem com os dados disponíveis
        const resposta = await processarMensagem(
          conversa,
          texto,
          nomeCliente,
          dadosBarbearia,
          precisaCacheWrite
        )

        // Atualiza histórico
        const historicoAtualizado = [
          ...(conversa.historic as any[]),
          { role: "user", content: texto },
          { role: "assistant", content: resposta }
        ]

        // Verifica se tem confirmação de agendamento
        let novoStatus = "em_andamento"
        if (resposta.includes("AGENDAMENTO_CONFIRMADO:")) {
          const jsonMatch = resposta.match(/AGENDAMENTO_CONFIRMADO:(\{.*\})/)
          if (jsonMatch) {
            const agendamento = JSON.parse(jsonMatch[1])
            console.log("AGENDAMENTO CRIADO:", agendamento)
            await criarAgendamento(conversa.barbershop_id!, agendamento, from, nomeCliente)
            novoStatus = "concluida"
          }
        }

        await atualizarConversa(conversa.id, historicoAtualizado, novoStatus)
        await enviarWhatsApp(phoneNumberId, from, resposta)
        console.log(`Resposta enviada para ${from}`)
      }

      if (value?.statuses?.length > 0) {
        const status = value.statuses[0]
        console.log(`Status: ${status.status} para ${status.recipient_id}`)
      }

      return new Response("OK", { status: 200 })
    } catch (error) {
      console.error("Erro ao processar webhook:", error)
      return new Response("OK", { status: 200 })
    }
  }

  return new Response("Metodo nao suportado", { status: 405 })
})

// ============================================
// FUNÇÕES AUXILIARES
// ============================================

async function getOuCriarConversa(
  phoneNumberId: string,
  clienteNumero: string,
  nomeCliente: string
): Promise<any> {
  // Busca barbearia pelo phone_number_id (match com barbershops.phone)
  const { data: barbearia } = await supabase
    .from("barbershops")
    .select("id")
    .eq("whatsapp_phone_number_id", phoneNumberId)
    .single()

  if (!barbearia) {
    throw new Error(`Barbearia não encontrada para phone: ${phoneNumberId}`)
  }

  // Busca conversa em andamento
  const { data: existente } = await supabase
    .from("conversations_chatbot")
    .select("*")
    .eq("barbershop_id", barbearia.id)
    .eq("client_phone_number_id", clienteNumero)
    .eq("status", "em_andamento")
    .order("updated_at", { ascending: false })
    .limit(1)
    .single()

  if (existente) return existente

  // Cria nova conversa
  const { data: nova, error } = await supabase
    .from("conversations_chatbot")
    .insert({
      barbershop_id: barbearia.id,
      barbershop_phone_number_id: phoneNumberId,
      client_phone_number_id: clienteNumero,
      historic: [],
      status: "em_andamento",
    })
    .select()
    .single()

  if (error) {
    console.error("Erro ao criar conversa:", error)
    throw error
  }
  return nova
}

async function inicializarConversa(
  phoneNumberId: string,
  conversaId: string,
  nomeCliente: string
): Promise<{
  dadosBarbearia: DadosBarbearia
  precisaCacheWrite: boolean
  conversaAtualizada: any
}> {
  // 1. BUSCA BARBEARIA
  const { data: barbearia } = await supabase
    .from("barbershops")
    .select(`
      id,
      name,
      phone,
      addresses(city, neighborhood, street, number)
    `)
    .eq("whatsapp_phone_number_id", phoneNumberId)
    .single()

  if (!barbearia) throw new Error("Barbearia não encontrada")

  // 2. BUSCA SERVIÇOS
  const { data: servicos } = await supabase
    .from("services")
    .select("id, name, price, duration_min")
    .eq("barbershop_id", barbearia.id)
    .eq("is_active", true)

  // 3. BUSCA BARBEIROS COM DISPONIBILIDADE
  const { data: barbeiros } = await supabase
    .from("barbers")
    .select(`
      id,
      name,
      description,
      barber_availability(day_of_week, starts_at, ends_at, is_day_off),
      barber_services(service_id)
    `)
    .eq("barbershop_id", barbearia.id)
    .eq("is_active", true)

  // 4. MONTA OBJETO DE DADOS
  const dadosBarbearia: DadosBarbearia = {
    barbershop_id: barbearia.id,
    barbershop_name: barbearia.name,
    phone: barbearia.phone,
    address: `${barbearia.addresses?.[0]?.street}, ${barbearia.addresses?.[0]?.number} - ${barbearia.addresses?.[0]?.neighborhood}, ${barbearia.addresses?.[0]?.city}`,
    servicos: servicos || [],
    barbeiros: (barbeiros || []).map((b: any) => ({
      id: b.id,
      name: b.name,
      description: b.description || "",
      availability: (b.barber_availability || []).filter((a: any) => !a.is_day_off),
      services: (b.barber_services || []).map((s: any) => s.service_id)
    })),
    hash: "", // calculado abaixo
    atualizado_em: new Date().toISOString()
  }

  // 5. GERA HASH
  dadosBarbearia.hash = await gerarHashSHA256(JSON.stringify({
    servicos: dadosBarbearia.servicos,
    barbeiros: dadosBarbearia.barbeiros.map(b => ({
      id: b.id,
      services: b.services,
      availability: b.availability
    }))
  }))

  // 6. VERIFICA CACHE LOCAL (tabela cache_barbearia - precisa criar!)
  // Por enquanto, sempre faz cache write na primeira conversa
  const precisaCacheWrite = true

  // 7. ATUALIZA CONVERSA COM DADOS NO HISTÓRICO
  const historicoComDados = [
    {
      role: "system",
      tipo: "dados_barbearia",
      content: dadosBarbearia
    },
    {
      role: "system",
      tipo: "estado_coleta",
      content: {
        etapa: "inicio",
        dados_barbearia: dadosBarbearia
      } as EstadoColeta
    }
  ]

  const { data: atualizada } = await supabase
    .from("conversations_chatbot")
    .update({
      historic: historicoComDados,
      updated_at: new Date().toISOString()
    })
    .eq("id", conversaId)
    .select()
    .single()

  return {
    dadosBarbearia,
    precisaCacheWrite,
    conversaAtualizada: atualizada
  }
}

async function processarMensagem(
  conversa: any,
  texto: string,
  nomeCliente: string,
  dadosBarbearia?: DadosBarbearia,
  precisaCacheWrite: boolean = false
): Promise<string> {
  
  try {
    // Recupera estado atual do histórico
    const estadoMsg = (conversa.historic as any[]).find(
      (h: any) => h.role === 'system' && h.tipo === 'estado_coleta'
    )
    
    let estado: EstadoColeta = estadoMsg?.content || { etapa: 'inicio' }
    
    // Se tem dados novos, atualiza estado
    if (dadosBarbearia) {
      estado.dados_barbearia = dadosBarbearia
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY")
    if (!apiKey) return "Desculpe, erro técnico."

    // Extrai intenção (simplificado - pode melhorar com NLP)
    const intencao = texto.toLowerCase()

    switch (estado.etapa) {
      case 'inicio':
        estado.etapa = 'servico'
        await atualizarEstado(conversa.id, conversa.historic, estado)
        
        return await chamarHaikuBoasVindas(
          dadosBarbearia!,
          nomeCliente,
          precisaCacheWrite,
          apiKey,
          conversa.historic 
        )

      case 'servico':
        const servico = dadosBarbearia?.servicos.find(s => 
          intencao.includes(s.name.toLowerCase()) ||
          (s.name.toLowerCase().includes('corte') && intencao.includes('corte'))
        )
        
        if (servico) {
          estado.servico_escolhido = servico
          estado.etapa = 'dia'
          await atualizarEstado(conversa.id, conversa.historic, estado)
          
          return `Beleza! ${servico.name} escolhido (R$${servico.price}). Pra quando? Hoje ou outro dia?`
        }
        
        return await chamarHaikuComContexto(
          dadosBarbearia!,
          nomeCliente,
          "O cliente não escolheu um serviço válido. Repita as opções de serviço.",
          conversa.historic,
          apiKey
        )

      case 'dia':
        const dia = parsearDia(intencao)
        
        if (dia) {
          estado.dia_escolhido = dia.data
          estado.dia_semana = dia.diaSemana
          estado.etapa = 'barbeiro'
          
          const barbeirosFiltrados = dadosBarbearia?.barbeiros.filter(b => 
            b.availability.some(a => a.day_of_week === dia.diaSemana) &&
            b.services.includes(estado.servico_escolhido!.id)
          ) || []
          
          estado.barbeiros_disponiveis = barbeirosFiltrados.map(b => ({
            id: b.id,
            name: b.name,
            description: b.description
          }))
          
          await atualizarEstado(conversa.id, conversa.historic, estado)
          
          if (barbeirosFiltrados.length === 0) {
            return `Infelizmente nenhum barbeiro disponível para ${estado.servico_escolhido!.name} no ${dia.label}. Que tal outro dia?`
          }
          
          const listaBarbeiros = barbeirosFiltrados.map(b => 
            `${b.name}${b.description ? ` (${b.description})` : ''}`
          ).join(', ')
          
          return `No ${dia.label} temos: ${listaBarbeiros}. Qual você prefere?`
        }
        
        return "Não entendi. Pode repetir o dia? (hoje, amanhã, ou dia da semana)"

      case 'barbeiro':
        // 🔥 PROTEÇÃO: verifica se barbeiros_disponiveis existe
        if (!estado.barbeiros_disponiveis || estado.barbeiros_disponiveis.length === 0) {
          estado.etapa = 'dia'
          await atualizarEstado(conversa.id, conversa.historic, estado)
          return "Desculpe, tive um problema. Que dia você quer agendar?"
        }
        
        const barbeiroEscolhido = estado.barbeiros_disponiveis?.find(b => 
          intencao.includes(b.name.toLowerCase())
        )
        
        if (barbeiroEscolhido) {
          estado.barbeiro_escolhido = barbeiroEscolhido
          estado.etapa = 'horario'
          
          const barbeiroFull = dadosBarbearia?.barbeiros.find(b => b.id === barbeiroEscolhido.id)
          const availability = barbeiroFull?.availability.find(a => a.day_of_week === estado.dia_semana)
          
          if (availability) {
            const slots = gerarSlotsHorario(
              availability.starts_at,
              availability.ends_at,
              estado.servico_escolhido!.duration_min
            )
            
            const slotsLivres = await filtrarHorariosOcupados(
              dadosBarbearia!.barbershop_id,
              barbeiroEscolhido.id,
              estado.dia_escolhido!,
              slots
            )
            
            estado.horarios_disponiveis = slotsLivres
            await atualizarEstado(conversa.id, conversa.historic, estado)
            
            if (slotsLivres.length === 0) {
              return `${barbeiroEscolhido.name} está lotado no ${estado.dia_escolhido}. Que tal outro barbeiro ou outro dia?`
            }
            
            return `${barbeiroEscolhido.name} escolhido! Horários livres: ${slotsLivres.join(', ')}. Qual horário?`
          }
        }
        
        const listaNomes = estado.barbeiros_disponiveis.map(b => b.name).join(', ')
        return `Não entendi. Os barbeiros disponíveis são: ${listaNomes}. Qual você prefere?`

      case 'horario':
        if (!estado.horarios_disponiveis || estado.horarios_disponiveis.length === 0) {
          estado.etapa = 'dia'
          await atualizarEstado(conversa.id, conversa.historic, estado)
          return "Desculpe, não tenho horários disponíveis. Que tal outro dia?"
        }
        
        const horarioMatch = estado.horarios_disponiveis?.find(h => 
          intencao.includes(h.replace(':', '')) || 
          intencao.includes(h) ||
          intencao.includes(h.split(':')[0] + 'h')
        )
        
        if (horarioMatch) {
          estado.horario_escolhido = horarioMatch
          estado.etapa = 'confirmacao'
          await atualizarEstado(conversa.id, conversa.historic, estado)
          
          return `Confirmar: ${estado.servico_escolhido!.name} com ${estado.barbeiro_escolhido!.name} no dia ${estado.dia_escolhido} às ${horarioMatch}? (sim/não)`
        }
        
        return `Horários disponíveis: ${estado.horarios_disponiveis?.join(', ')}. Qual você prefere?`

      case 'confirmacao':
        if (intencao.match(/sim|confirma|pode ser|tá bom|fechado|yes/)) {
          return `Agendado! ${estado.servico_escolhido!.name} com ${estado.barbeiro_escolhido!.name} dia ${estado.dia_escolhido} às ${estado.horario_escolhido}. Te esperamos! 💈\nAGENDAMENTO_CONFIRMADO:{"servico":"${estado.servico_escolhido!.name}","barbeiro":"${estado.barbeiro_escolhido!.name}","data":"${estado.dia_escolhido}","hora":"${estado.horario_escolhido}"}`
        }
        
        if (intencao.match(/não|nao|cancela|outro/)) {
          estado.etapa = 'servico'
          estado.servico_escolhido = undefined
          estado.barbeiro_escolhido = undefined
          estado.horario_escolhido = undefined
          await atualizarEstado(conversa.id, conversa.historic, estado)
          
          return "Sem problema! Vamos recomeçar. Qual serviço você quer? " + 
            dadosBarbearia?.servicos.map(s => `${s.name} (R$${s.price})`).join(', ')
        }
        
        return "Não entendi. Confirma o agendamento? (sim ou não)"
    }

    return "Desculpe, não entendi. Pode repetir?"
    
  } catch (error) {
    // 🔥 GARANTE QUE SEMPRE TENHA UMA RESPOSTA
    console.error("🔴 [ERRO CRÍTICO] processarMensagem:", error)
    return `Olá ${nomeCliente}! Desculpe o transtorno. Por favor, vamos recomeçar. Qual serviço você quer agendar? Temos: ${dadosBarbearia?.servicos.map(s => s.name).join(', ') || "Corte e Barba"}.`
  }
}

// ============================================
// FUNÇÕES HAiku
// ============================================

async function chamarHaikuBoasVindas(
  dados: DadosBarbearia,
  nomeCliente: string,
  precisaCacheWrite: boolean,
  apiKey: string,
  historico: any[]
): Promise<string> {
  
  console.log("🔵 [DEBUG] Entrou em chamarHaikuBoasVindas")
  console.log("🔵 [DEBUG] nomeCliente:", nomeCliente)
  console.log("🔵 [DEBUG] dados.barbershop_name:", dados.barbershop_name)
  console.log("🔵 [DEBUG] dados.servicos:", dados.servicos.length)
  
  const systemPrompt = montarSystemPrompt(dados, nomeCliente, precisaCacheWrite, 'boas_vindas')
  console.log("🔵 [DEBUG] systemPrompt criado, tamanho:", systemPrompt.length)
  
  const mensagensAnteriores = historico
    .filter((h: any) => h.role === 'user' || h.role === 'assistant')
    .slice(-6)
  
  console.log("🔵 [DEBUG] mensagensAnteriores:", mensagensAnteriores.length)
  
  // Se não tem histórico, cria uma mensagem inicial
  const messages = mensagensAnteriores.length > 0 
    ? mensagensAnteriores 
    : [{ role: "user", content: `Meu nome é ${nomeCliente}` }]
  
  console.log("🔵 [DEBUG] messages enviadas:", JSON.stringify(messages))
  
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31" 
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: systemPrompt,
        messages: messages,
      }),
    })

    const data = await response.json()
    console.log("🔵 [DEBUG] Resposta da API:", JSON.stringify(data).substring(0, 500))
    
    if (data.usage) {
      console.log(`[CACHE] write: ${data.usage.cache_creation_input_tokens || 0}, read: ${data.usage.cache_read_input_tokens || 0}`)
    }

    if (data.content && data.content[0] && data.content[0].text) {
      return data.content[0].text
    }
    
    console.error("🔴 [ERRO] Resposta inesperada do Haiku:", JSON.stringify(data))
    return `Olá ${nomeCliente}! Bem-vindo à ${dados.barbershop_name}. Temos ${dados.servicos.map(s => s.name).join(', ')}. Qual serviço você quer agendar?`
    
  } catch (error) {
    console.error("🔴 [ERRO] Exceção ao chamar Haiku:", error)
    return `Olá ${nomeCliente}! Bem-vindo à ${dados.barbershop_name}. Temos ${dados.servicos.map(s => s.name).join(', ')}. Qual serviço você quer agendar?`
  }
}

async function chamarHaikuComContexto(
  dados: DadosBarbearia,
  nomeCliente: string,
  contexto: string,
  historico: any[],  // ← JÁ TEM
  apiKey: string
): Promise<string> {
  
  const systemBlocks = montarSystemPrompt(dados, nomeCliente, false, 'contexto')
  
  // 🔥 USA O HISTÓRICO REAL + CONTEXTO ATUAL
  const mensagensAnteriores = historico
    .filter((h: any) => h.role === 'user' || h.role === 'assistant')
    .slice(-8)
  
  const messages = [
    ...mensagensAnteriores,
    { role: "user", content: contexto }
  ]
  
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31"  // ✅ ADICIONADO
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",  // ✅ MODELO CORRETO
      max_tokens: 300,
      system: systemBlocks,
      messages: messages,
    }),
  })

  const data = await response.json()
  return data.content?.[0]?.text || "Desculpe, não entendi. Pode repetir?"
}

function montarSystemPrompt(
  dados: DadosBarbearia,
  nomeCliente: string,
  precisaCacheWrite: boolean,
  tipo: 'boas_vindas' | 'contexto'
): string {
  // Retorna uma string SIMPLES, não um array
  return `Você é o assistente virtual de agendamento da barbearia ${dados.barbershop_name}.

=== SEU TRABALHO ===
Ajude clientes a agendar serviços de forma rápida e amigável.

=== INFORMAÇÕES DA BARBEARIA ===
Nome: ${dados.barbershop_name}
Endereço: ${dados.address}
Telefone: ${dados.phone}

=== SERVIÇOS ===
${dados.servicos.map(s => `- ${s.name}: R$${s.price} (${s.duration_min}min)`).join('\n')}

=== BARBEIROS ===
${dados.barbeiros.map(b => `- ${b.name}${b.description ? `: ${b.description}` : ''}`).join('\n')}

=== REGRAS IMPORTANTES ===
1. Sempre cumprimente o cliente pelo nome: ${nomeCliente}
2. Se o cliente disser "Oi", "Olá", "Bom dia" → responda com uma saudação e pergunte se quer agendar
3. Se o cliente disser "Quero agendar" → pergunte qual serviço ele deseja
4. Mantenha respostas curtas (máximo 2-3 frases)
5. Use português brasileiro natural, informal e amigável
6. Nunca diga "Desculpe, não entendi" para saudações ou pedidos simples

${tipo === 'boas_vindas' 
  ? 'INSTRUÇÃO: Dê boas-vindas calorosas e pergunte qual serviço o cliente quer agendar.'
  : 'INSTRUÇÃO: Continue a conversa naturalmente, coletando as informações necessárias para o agendamento.'
}

LEMBRE-SE: O cliente disse "${nomeCliente}". Trate-o pelo nome!`
}

// ============================================
// FUNÇÕES UTILITÁRIAS
// ============================================

async function atualizarEstado(
  conversaId: string,
  historic: any[],
  estado: EstadoColeta
): Promise<void> {
  const novoHistorico = historic.filter((h: any) => h.tipo !== 'estado_coleta')
  novoHistorico.push({
    role: "system",
    tipo: "estado_coleta",
    content: estado
  })
  
  await supabase
    .from("conversations_chatbot")
    .update({
      historic: novoHistorico,
      updated_at: new Date().toISOString()
    })
    .eq("id", conversaId)
}

async function atualizarConversa(
  conversaId: string,
  historico: any[],
  status: string
): Promise<void> {
  const { error } = await supabase
    .from("conversations_chatbot")
    .update({
      historic: historico,
      status: status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversaId)

  if (error) console.error("Erro ao atualizar conversa:", error)
}

async function criarAgendamento(
  barbershopId: string,
  agendamento: any,
  clienteTelefone: string,
  clienteNome: string
): Promise<void> {
  // Busca ou cria cliente
  let customerId: string | null = null
  
  const { data: clienteExistente } = await supabase
    .from("customers")
    .select("id")
    .eq("phone", clienteTelefone)
    .eq("barbershop_id", barbershopId)
    .single()
  
  if (clienteExistente) {
    customerId = clienteExistente.id
  } else {
    const { data: novoCliente } = await supabase
      .from("customers")
      .insert({
        barbershop_id: barbershopId,
        name: clienteNome,
        phone: clienteTelefone
      })
      .select()
      .single()
    customerId = novoCliente?.id || null
  }

  // Busca IDs reais
  const { data: servico } = await supabase
    .from("services")
    .select("id, duration_min")
    .eq("barbershop_id", barbershopId)
    .eq("name", agendamento.servico)
    .single()
  
  const { data: barbeiro } = await supabase
    .from("barbers")
    .select("id")
    .eq("barbershop_id", barbershopId)
    .eq("name", agendamento.barbeiro)
    .single()

  if (!servico || !barbeiro) {
    console.error("Serviço ou barbeiro não encontrado:", agendamento)
    return
  }

  // Calcula horário de término
  const startsAt = new Date(`${agendamento.data}T${agendamento.hora}:00`)
  const endsAt = new Date(startsAt.getTime() + (servico.duration_min || 30) * 60000)

  // Cria agendamento
  const { error } = await supabase.from("appointments").insert({
    barbershop_id: barbershopId,
    customer_id: customerId,
    barber_id: barbeiro.id,
    service_id: servico.id,
    service_name: agendamento.servico,
    service_price: 0, // Buscar do serviço
    service_duration: servico.duration_min,
    barber_name: agendamento.barbeiro,
    customer_name: clienteNome,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    status: 'scheduled'
  })

  if (error) {
    console.error("Erro ao criar agendamento:", error)
  } else {
    console.log("Agendamento criado com sucesso!")
  }
}

async function enviarWhatsApp(
  phoneNumberId: string,
  to: string,
  texto: string
): Promise<void> {
  const token = Deno.env.get("WHATSAPP_TOKEN")
  if (!token) {
    console.error("WHATSAPP_TOKEN não configurado!")
    return
  }

  const textoLimpo = texto
    .replace(/AGENDAMENTO_CONFIRMADO:\{.*\}/s, "")
    .trim()

  try {
    const response = await fetch(
      `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: to,
          type: "text",
          text: { body: textoLimpo },
        }),
      }
    )

    const result = await response.json()
    if (result.error) {
      console.error("Erro ao enviar WhatsApp:", JSON.stringify(result.error))
    }
  } catch (error) {
    console.error("Erro na requisição WhatsApp:", error)
  }
}

// ============================================
// FUNÇÕES DE DATA/HORA
// ============================================

function parsearDia(texto: string): { data: string; diaSemana: number; label: string } | null {
  const hoje = new Date()
  const amanha = new Date(hoje)
  amanha.setDate(amanha.getDate() + 1)
  
  const normalizado = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  
  // Hoje
  if (normalizado.match(/hoje/)) {
    return {
      data: formatarDataISO(hoje),
      diaSemana: hoje.getDay(),
      label: 'hoje'
    }
  }
  
  // Amanhã
  if (normalizado.match(/amanha|amanhã/)) {
    return {
      data: formatarDataISO(amanha),
      diaSemana: amanha.getDay(),
      label: 'amanhã'
    }
  }
  
  // Dias da semana
  const diasSemana = [
    { regex: /dom(ingo)?/, dia: 0 },
    { regex: /seg(unda)?/, dia: 1 },
    { regex: /ter(ca|ça)?/, dia: 2 },
    { regex: /qua(rteira)?/, dia: 3 },
    { regex: /qui(nte)?/, dia: 4 },
    { regex: /sex(ta)?/, dia: 5 },
    { regex: /sab(ado|ábado)?/, dia: 6 },
  ]
  
  for (const dia of diasSemana) {
    if (normalizado.match(dia.regex)) {
      const dataAlvo = proximoDiaSemana(dia.dia)
      return {
        data: formatarDataISO(dataAlvo),
        diaSemana: dia.dia,
        label: ['domingo','segunda','terça','quarta','quinta','sexta','sábado'][dia.dia]
      }
    }
  }
  
  // Data específica (DD/MM ou DD/MM/YYYY)
  const matchData = texto.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?/)
  if (matchData) {
    const dia = parseInt(matchData[1])
    const mes = parseInt(matchData[2]) - 1
    const ano = matchData[3] ? parseInt(matchData[3]) : hoje.getFullYear()
    
    const data = new Date(ano, mes, dia)
    return {
      data: formatarDataISO(data),
      diaSemana: data.getDay(),
      label: `${dia}/${mes + 1}`
    }
  }
  
  return null
}

function proximoDiaSemana(diaSemana: number): Date {
  const hoje = new Date()
  const hojeDia = hoje.getDay()
  let diasParaAdicionar = diaSemana - hojeDia
  
  if (diasParaAdicionar <= 0) {
    diasParaAdicionar += 7 // Próxima semana
  }
  
  const resultado = new Date(hoje)
  resultado.setDate(hoje.getDate() + diasParaAdicionar)
  return resultado
}

function formatarDataISO(data: Date): string {
  return data.toISOString().split('T')[0]
}

function gerarSlotsHorario(
  horaInicio: string,
  horaFim: string,
  duracaoMinutos: number
): string[] {
  // 🔥 PROTEÇÃO contra valores nulos
  if (!horaInicio || !horaFim) {
    console.error("gerarSlotsHorario: horaInicio ou horaFim é null", { horaInicio, horaFim })
    return ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"] // horários padrão
  }
  
  const slots: string[] = []
  
  const [hInicio, mInicio] = horaInicio.split(':').map(Number)
  const [hFim, mFim] = horaFim.split(':').map(Number)
  
  // 🔥 PROTEÇÃO contra NaN
  if (isNaN(hInicio) || isNaN(mInicio) || isNaN(hFim) || isNaN(mFim)) {
    console.error("gerarSlotsHorario: valores inválidos", { hInicio, mInicio, hFim, mFim })
    return ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"]
  }
  
  let atual = new Date(2000, 0, 1, hInicio, mInicio)
  const fim = new Date(2000, 0, 1, hFim, mFim)
  
  while (atual < fim) {
    const horaStr = `${String(atual.getHours()).padStart(2, '0')}:${String(atual.getMinutes()).padStart(2, '0')}`
    slots.push(horaStr)
    atual = new Date(atual.getTime() + duracaoMinutos * 60000)
  }
  
  return slots.length > 0 ? slots : ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"]
}

async function filtrarHorariosOcupados(
  barbershopId: string,
  barberId: string,
  data: string,
  slots: string[]
): Promise<string[]> {
  // Busca agendamentos existentes
  const inicioDia = `${data}T00:00:00`
  const fimDia = `${data}T23:59:59`
  
  const { data: agendamentos } = await supabase
    .from("appointments")
    .select("starts_at, ends_at")
    .eq("barbershop_id", barbershopId)
    .eq("barber_id", barberId)
    .gte("starts_at", inicioDia)
    .lte("starts_at", fimDia)
    .neq("status", "cancelled")
  
  if (!agendamentos || agendamentos.length === 0) {
    return slots
  }
  
  // Filtra slots que conflitam com agendamentos existentes
  const slotsLivres = slots.filter(slot => {
    const slotInicio = new Date(`${data}T${slot}:00`)
    const slotFim = new Date(slotInicio.getTime() + 30 * 60000) // Assume 30min por slot
    
    for (const agend of agendamentos) {
      const agendInicio = new Date(agend.starts_at)
      const agendFim = new Date(agend.ends_at)
      
      // Verifica se há sobreposição
      if (slotInicio < agendFim && slotFim > agendInicio) {
        return false // Conflita
      }
    }
    
    return true
  })
  
  return slotsLivres
}

async function gerarHashSHA256(texto: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(texto)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}