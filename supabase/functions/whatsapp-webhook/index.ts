import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

// ============================================
// CONSTANTES E CONFIGURAÇÃO
// ============================================
const VERIFY_TOKEN = "virtual_barber_webhook_2026"
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || ""
// ID fixo da barbearia de teste — configurar na env do Supabase
const BARBERSHOP_TEST_ID = Deno.env.get("BARBERSHOP_TEST_ID") || ""
const TEMPO_SESSAO_HORAS = 4

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
)

// ============================================
// TIPOS
// ============================================
interface Servico {
  id: string
  name: string
  price: number
  duration_min: number
}

interface DisponibilidadeBarbeiro {
  day_of_week: number
  starts_at: string
  ends_at: string
  is_day_off: boolean
  period_order: number
}

interface Barbeiro {
  id: string
  name: string
  description: string
  availability: DisponibilidadeBarbeiro[]
  services: string[] // IDs dos serviços que realiza
}

interface DadosBarbearia {
  barbershop_id: string
  barbershop_name: string
  phone: string
  address: string
  servicos: Servico[]
  barbeiros: Barbeiro[]
}

interface EstadoColeta {
  etapa: "inicio" | "servico" | "dia" | "barbeiro" | "horario" | "confirmacao"
  servico_escolhido?: Servico
  dia_escolhido?: string   // YYYY-MM-DD
  dia_semana?: number      // 0-6
  dia_label?: string
  barbeiros_disponiveis?: Array<{ id: string; name: string; description: string }>
  barbeiro_escolhido?: { id: string; name: string } // id pode ser 'sem_preferencia'
  // Para "sem preferência": slot -> lista de barbeiro_ids livres naquele slot
  slot_barbeiros_map?: Record<string, string[]>
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

      if (value?.statuses?.length > 0) {
        console.log(`Status: ${value.statuses[0].status}`)
        return new Response("OK", { status: 200 })
      }

      if (!value?.messages?.length) {
        return new Response("OK", { status: 200 })
      }

      const msg = value.messages[0]
      const from = msg.from
      const phoneNumberId = value.metadata?.phone_number_id || value.phone_number_id
      const nomeCliente = value.contacts?.[0]?.profile?.name || "Cliente"

      if (msg.type !== "text") {
        await enviarWhatsApp(
          phoneNumberId,
          from,
          "Desculpe, ainda não consigo processar esse tipo de mensagem. Por favor, envie texto."
        )
        return new Response("OK", { status: 200 })
      }

      const texto = msg.text.body.trim()
      console.log(`[MSG] ${nomeCliente} (${from}): ${texto}`)

      // Recupera ou cria sessão de conversa
      const { conversa, isNova } = await getOuCriarConversa(phoneNumberId, from)
      let historico: any[] = conversa.historic as any[]

      // Busca dados da barbearia (sempre necessário)
      let dadosBarbearia = extrairDadosBarbearia(historico)
      if (!dadosBarbearia || isNova) {
        dadosBarbearia = await buscarDadosBarbearia()
        if (!dadosBarbearia) {
          await enviarWhatsApp(phoneNumberId, from, "Desculpe, estamos com dificuldades técnicas. Tente novamente em instantes.")
          return new Response("OK", { status: 200 })
        }
        if (isNova) {
          historico = gerarHistoricoInicial(dadosBarbearia)
          await atualizarHistorico(conversa.id, historico, "em_andamento")
        } else {
          // Apenas atualiza os dados da barbearia no histórico existente
          historico = substituirDadosBarbearia(historico, dadosBarbearia)
        }
      }

      const estado = extrairEstado(historico)

      const { resposta, estadoAtualizado, novoStatus } = await processarMensagem(
        texto,
        nomeCliente,
        from,
        dadosBarbearia,
        estado,
        historico,
        isNova
      )

      // Salva mensagem do usuário, resposta e estado atualizado no histórico
      const historicoFinal = [
        ...historico.filter(
          (h: any) => !(h.role === "system" && h.tipo === "estado_coleta")
        ),
        { role: "user", content: texto },
        { role: "assistant", content: resposta },
        { role: "system", tipo: "estado_coleta", content: estadoAtualizado },
      ]

      await atualizarHistorico(conversa.id, historicoFinal, novoStatus)
      await enviarWhatsApp(phoneNumberId, from, resposta)
      console.log(`[RESP] → ${from}: ${resposta.substring(0, 80)}...`)

      return new Response("OK", { status: 200 })
    } catch (error) {
      console.error("[ERRO CRÍTICO]", error)
      return new Response("OK", { status: 200 })
    }
  }

  return new Response("Metodo nao suportado", { status: 405 })
})

// ============================================
// GESTÃO DE SESSÃO
// ============================================

async function getOuCriarConversa(
  phoneNumberId: string,
  clienteNumero: string
): Promise<{ conversa: any; isNova: boolean }> {
  if (!BARBERSHOP_TEST_ID) {
    throw new Error("BARBERSHOP_TEST_ID não configurado")
  }

  // Busca conversa em andamento para este cliente
  const { data: existente } = await supabase
    .from("conversations_chatbot")
    .select("*")
    .eq("barbershop_id", BARBERSHOP_TEST_ID)
    .eq("client_phone_number_id", clienteNumero)
    .eq("status", "em_andamento")
    .order("updated_at", { ascending: false })
    .limit(1)
    .single()

  if (existente) {
    const updatedAt = new Date(existente.updated_at)
    const agora = new Date()
    const diferencaHoras = (agora.getTime() - updatedAt.getTime()) / (1000 * 60 * 60)

    if (diferencaHoras < TEMPO_SESSAO_HORAS) {
      console.log(`[SESSÃO] Conversa ativa encontrada (${diferencaHoras.toFixed(1)}h atrás)`)
      return { conversa: existente, isNova: false }
    }

    // Sessão expirada — exclui e cria nova
    console.log(`[SESSÃO] Sessão expirada (${diferencaHoras.toFixed(1)}h). Criando nova...`)
    await supabase
      .from("conversations_chatbot")
      .delete()
      .eq("id", existente.id)
  }

  // Cria nova conversa
  const { data: nova, error } = await supabase
    .from("conversations_chatbot")
    .insert({
      barbershop_id: BARBERSHOP_TEST_ID,
      barbershop_phone_number_id: phoneNumberId,
      client_phone_number_id: clienteNumero,
      historic: [],
      status: "em_andamento",
    })
    .select()
    .single()

  if (error || !nova) {
    console.error("[ERRO] Falha ao criar conversa:", error)
    throw new Error("Não foi possível criar a conversa")
  }

  console.log("[SESSÃO] Nova conversa criada:", nova.id)
  return { conversa: nova, isNova: true }
}

// ============================================
// DADOS DA BARBEARIA
// ============================================

async function buscarDadosBarbearia(): Promise<DadosBarbearia | null> {
  const { data: barbearia } = await supabase
    .from("barbershops")
    .select("id, name, phone, addresses(city, neighborhood, street, number)")
    .eq("id", BARBERSHOP_TEST_ID)
    .single()

  if (!barbearia) {
    console.error("[ERRO] Barbearia de teste não encontrada:", BARBERSHOP_TEST_ID)
    return null
  }

  const { data: servicos } = await supabase
    .from("services")
    .select("id, name, price, duration_min")
    .eq("barbershop_id", BARBERSHOP_TEST_ID)
    .eq("is_active", true)
    .order("name")

  const { data: barbeiros } = await supabase
    .from("barbers")
    .select(`
      id, name, description,
      barber_availability(day_of_week, starts_at, ends_at, is_day_off, period_order),
      barber_services(service_id)
    `)
    .eq("barbershop_id", BARBERSHOP_TEST_ID)
    .eq("is_active", true)

  const addr = barbearia.addresses?.[0]
  const enderecoFormatado = addr
    ? `${addr.street}, ${addr.number} - ${addr.neighborhood}, ${addr.city}`
    : "Endereço não informado"

  return {
    barbershop_id: barbearia.id,
    barbershop_name: barbearia.name,
    phone: barbearia.phone || "",
    address: enderecoFormatado,
    servicos: (servicos || []) as Servico[],
    barbeiros: (barbeiros || []).map((b: any) => ({
      id: b.id,
      name: b.name,
      description: b.description || "",
      availability: (b.barber_availability || []) as DisponibilidadeBarbeiro[],
      services: (b.barber_services || []).map((s: any) => s.service_id),
    })),
  }
}

// ============================================
// HISTÓRICO (helpers)
// ============================================

function gerarHistoricoInicial(dados: DadosBarbearia): any[] {
  return [
    { role: "system", tipo: "dados_barbearia", content: dados },
    { role: "system", tipo: "estado_coleta", content: { etapa: "inicio" } as EstadoColeta },
  ]
}

function substituirDadosBarbearia(historico: any[], dados: DadosBarbearia): any[] {
  const semDados = historico.filter(
    (h: any) => !(h.role === "system" && h.tipo === "dados_barbearia")
  )
  return [{ role: "system", tipo: "dados_barbearia", content: dados }, ...semDados]
}

function extrairDadosBarbearia(historico: any[]): DadosBarbearia | null {
  return (
    historico.find((h: any) => h.role === "system" && h.tipo === "dados_barbearia")
      ?.content || null
  )
}

function extrairEstado(historico: any[]): EstadoColeta {
  return (
    historico.find((h: any) => h.role === "system" && h.tipo === "estado_coleta")
      ?.content || { etapa: "inicio" }
  )
}

async function atualizarHistorico(
  conversaId: string,
  historico: any[],
  status: string
): Promise<void> {
  const { error } = await supabase
    .from("conversations_chatbot")
    .update({ historic: historico, status, updated_at: new Date().toISOString() })
    .eq("id", conversaId)

  if (error) console.error("[ERRO] atualizarHistorico:", error)
}

// ============================================
// PROCESSADOR DE MENSAGENS (máquina de estados)
// ============================================

async function processarMensagem(
  texto: string,
  nomeCliente: string,
  clienteTelefone: string,
  dados: DadosBarbearia,
  estado: EstadoColeta,
  historico: any[],
  isNova: boolean
): Promise<{ resposta: string; estadoAtualizado: EstadoColeta; novoStatus: string }> {
  let estadoAtualizado = { ...estado }
  let novoStatus = "em_andamento"

  try {
    // Nova sessão → boas-vindas independente da etapa salva
    if (isNova) {
      estadoAtualizado = { etapa: "servico" }
      const resposta = await haikuBoasVindas(dados, nomeCliente, historico)
      return { resposta, estadoAtualizado, novoStatus }
    }

    switch (estado.etapa) {
      // --------------------------------------------------
      case "inicio":
      case "servico": {
        if (estado.etapa === "inicio") {
          estadoAtualizado = { etapa: "servico" }
          const resposta = await haikuBoasVindas(dados, nomeCliente, historico)
          return { resposta, estadoAtualizado, novoStatus }
        }

        // Interpreta qual serviço o cliente quer (Haiku com fuzzy matching)
        const servicoId = await interpretarEscolhaHaiku(
          texto,
          dados.servicos.map((s) => ({ id: s.id, name: s.name })),
          "serviço"
        )

        if (servicoId) {
          const servico = dados.servicos.find((s) => s.id === servicoId)!
          estadoAtualizado = { etapa: "dia", servico_escolhido: servico }
          const precoFmt = servico.price
            ? `R$ ${Number(servico.price).toFixed(2).replace(".", ",")}`
            : ""
          return {
            resposta: `Ótimo! *${servico.name}*${precoFmt ? ` (${precoFmt})` : ""} escolhido! ✂️\n\nPra qual dia você quer agendar? Pode dizer hoje, amanhã, ou o dia da semana (ex: terça, sábado)...`,
            estadoAtualizado,
            novoStatus,
          }
        }

        // Não identificou o serviço → Haiku reformula
        const resposta = await haikuContexto(
          dados,
          nomeCliente,
          "O cliente não escolheu um serviço válido ou não entendemos. Reapresente a lista de serviços de forma amigável e peça para escolher.",
          historico
        )
        return { resposta, estadoAtualizado, novoStatus }
      }

      // --------------------------------------------------
      case "dia": {
        const dia = parsearDia(texto)

        if (!dia) {
          return {
            resposta: "Não entendi o dia. 😅 Pode dizer *hoje*, *amanhã* ou o dia da semana? (ex: *terça*, *sábado*)",
            estadoAtualizado,
            novoStatus,
          }
        }

        // Filtra barbeiros disponíveis no dia E que fazem o serviço escolhido
        const barbeirosFiltrados = dados.barbeiros.filter((b) => {
          const temDisponibilidade = b.availability.some(
            (a) => a.day_of_week === dia.diaSemana && !a.is_day_off
          )
          const fazServico = b.services.includes(estado.servico_escolhido!.id)
          return temDisponibilidade && fazServico
        })

        if (barbeirosFiltrados.length === 0) {
          estadoAtualizado = {
            ...estado,
            etapa: "dia",
            dia_escolhido: undefined,
            dia_semana: undefined,
          }
          return {
            resposta: `Infelizmente não há barbeiros disponíveis para *${estado.servico_escolhido!.name}* na *${dia.label}*. 😕\n\nQue tal escolher outro dia?`,
            estadoAtualizado,
            novoStatus,
          }
        }

        const disponiveis = barbeirosFiltrados.map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description,
        }))

        estadoAtualizado = {
          ...estado,
          etapa: "barbeiro",
          dia_escolhido: dia.data,
          dia_semana: dia.diaSemana,
          dia_label: dia.label,
          barbeiros_disponiveis: disponiveis,
        }

        const lista = disponiveis
          .map((b, i) => `${i + 1}. ${b.name}${b.description ? ` — ${b.description}` : ""}`)
          .join("\n")

        return {
          resposta: `Na *${dia.label}* temos os seguintes barbeiros disponíveis:\n\n${lista}\n${disponiveis.length + 1}. Sem preferência\n\nQual você prefere?`,
          estadoAtualizado,
          novoStatus,
        }
      }

      // --------------------------------------------------
      case "barbeiro": {
        if (!estado.barbeiros_disponiveis?.length) {
          estadoAtualizado = { ...estado, etapa: "dia" }
          return {
            resposta: "Desculpe, tive um problema. Para qual dia você quer agendar?",
            estadoAtualizado,
            novoStatus,
          }
        }

        // Verifica se cliente disse "sem preferência"
        const textoNorm = normalizar(texto)
        const semPreferencia = textoNorm.match(
          /sem prefer|tanto faz|qualquer|nao importa|não importa|qualquer um/
        ) || textoNorm === String(estado.barbeiros_disponiveis.length + 1)

        let barbeiroId: string | null = null

        if (semPreferencia) {
          barbeiroId = "sem_preferencia"
        } else {
          barbeiroId = await interpretarEscolhaHaiku(
            texto,
            estado.barbeiros_disponiveis,
            "barbeiro"
          )
        }

        if (!barbeiroId) {
          const lista = estado.barbeiros_disponiveis
            .map((b, i) => `${i + 1}. ${b.name}`)
            .join("\n")
          return {
            resposta: `Não entendi. Os barbeiros disponíveis são:\n\n${lista}\n${estado.barbeiros_disponiveis.length + 1}. Sem preferência\n\nQual você prefere?`,
            estadoAtualizado,
            novoStatus,
          }
        }

        // Gera slots disponíveis
        const { horarios, slotBarbeirosMap } = await gerarSlotsDisponiveis(
          dados,
          estado,
          barbeiroId
        )

        if (horarios.length === 0) {
          const nomeBarbeiro =
            barbeiroId === "sem_preferencia"
              ? "nenhum barbeiro"
              : estado.barbeiros_disponiveis.find((b) => b.id === barbeiroId)?.name || "o barbeiro"

          estadoAtualizado = { ...estado, etapa: "dia" }
          return {
            resposta: `${nomeBarbeiro === "nenhum barbeiro" ? "Não há" : `*${nomeBarbeiro}* não tem`} horários disponíveis para *${estado.dia_label}*. 😕\n\nQuer tentar outro dia?`,
            estadoAtualizado,
            novoStatus,
          }
        }

        const nomeBarbeiro =
          barbeiroId === "sem_preferencia"
            ? "Sem preferência"
            : estado.barbeiros_disponiveis.find((b) => b.id === barbeiroId)?.name || ""

        estadoAtualizado = {
          ...estado,
          etapa: "horario",
          barbeiro_escolhido: { id: barbeiroId, name: nomeBarbeiro },
          horarios_disponiveis: horarios,
          slot_barbeiros_map: slotBarbeirosMap,
        }

        const listaHorarios = horarios.map((h, i) => `${i + 1}. ${h}`).join("\n")
        return {
          resposta: `Horários disponíveis na *${estado.dia_label}*:\n\n${listaHorarios}\n\nQual horário prefere?`,
          estadoAtualizado,
          novoStatus,
        }
      }

      // --------------------------------------------------
      case "horario": {
        if (!estado.horarios_disponiveis?.length) {
          estadoAtualizado = { ...estado, etapa: "dia" }
          return {
            resposta: "Desculpe, tive um problema com os horários. Para qual dia você quer agendar?",
            estadoAtualizado,
            novoStatus,
          }
        }

        const horarioMatch = parsearHorario(texto, estado.horarios_disponiveis)

        if (!horarioMatch) {
          const lista = estado.horarios_disponiveis.join(", ")
          return {
            resposta: `Não entendi o horário. Os disponíveis são: ${lista}\n\nQual você prefere?`,
            estadoAtualizado,
            novoStatus,
          }
        }

        estadoAtualizado = {
          ...estado,
          etapa: "confirmacao",
          horario_escolhido: horarioMatch,
        }

        return {
          resposta: montarResumoAgendamento(estadoAtualizado),
          estadoAtualizado,
          novoStatus,
        }
      }

      // --------------------------------------------------
      case "confirmacao": {
        const textoNorm = normalizar(texto)

        if (textoNorm.match(/sim|confirma|pode ser|ta bom|tá bom|fechado|yes|ok|quero|confirmo/)) {
          // Tenta criar o agendamento
          const resultado = await criarAgendamento(dados, estado, nomeCliente, clienteTelefone)

          if (resultado.success) {
            novoStatus = "concluida"
            const dataFormatada = formatarDataExibicao(estado.dia_escolhido!)
            estadoAtualizado = { etapa: "servico" } // reseta para eventual próxima sessão
            return {
              resposta: `✅ *Agendamento confirmado!*\n\n${estado.servico_escolhido!.name} com ${estado.barbeiro_escolhido!.name === "Sem preferência" ? resultado.barbeiroNome : estado.barbeiro_escolhido!.name} na *${dataFormatada}* às *${estado.horario_escolhido}*.\n\nTe esperamos! Se precisar cancelar ou remarcar, entre em contato. 💈`,
              estadoAtualizado,
              novoStatus,
            }
          } else {
            // Falhou — não confirma ao cliente
            console.error("[ERRO] Falha ao criar agendamento:", resultado.error)
            return {
              resposta: `Desculpe, não consegui confirmar seu agendamento. 😔\n\n${resultado.error || "Ocorreu um erro técnico."}\n\nPor favor, tente novamente ou entre em contato conosco diretamente.`,
              estadoAtualizado,
              novoStatus,
            }
          }
        }

        if (textoNorm.match(/nao|não|cancela|outro|mudar|errado|corrigir/)) {
          estadoAtualizado = { etapa: "servico" }
          const lista = dados.servicos
            .map((s, i) => `${i + 1}. ${s.name}`)
            .join("\n")
          return {
            resposta: `Sem problema! Vamos recomeçar. 😊\n\nQual serviço você quer agendar?\n\n${lista}`,
            estadoAtualizado,
            novoStatus,
          }
        }

        return {
          resposta: `Confirma o agendamento? Responda *sim* para confirmar ou *não* para recomeçar.\n\n${montarResumoAgendamento(estado)}`,
          estadoAtualizado,
          novoStatus,
        }
      }
    }
  } catch (error) {
    console.error("[ERRO] processarMensagem:", error)
    const lista = dados.servicos.map((s) => s.name).join(", ")
    return {
      resposta: `Desculpe o transtorno, ${nomeCliente}! Tive um problema técnico. Vamos recomeçar? Qual serviço você quer agendar? (${lista})`,
      estadoAtualizado: { etapa: "servico" },
      novoStatus: "em_andamento",
    }
  }

  return {
    resposta: "Desculpe, não entendi. Pode repetir?",
    estadoAtualizado,
    novoStatus,
  }
}

// ============================================
// GERAÇÃO DE SLOTS DE HORÁRIO
// ============================================

async function gerarSlotsDisponiveis(
  dados: DadosBarbearia,
  estado: EstadoColeta,
  barbeiroId: string
): Promise<{ horarios: string[]; slotBarbeirosMap: Record<string, string[]> }> {
  const duracaoMinutos = Number(estado.servico_escolhido!.duration_min) || 30

  // Determina quais barbeiros considerar
  const barbeirosConsiderar =
    barbeiroId === "sem_preferencia"
      ? (estado.barbeiros_disponiveis || [])
      : (estado.barbeiros_disponiveis || []).filter((b) => b.id === barbeiroId)

  // Para cada barbeiro, gera slots de acordo com disponibilidade no dia
  const slotBarbeirosMap: Record<string, string[]> = {}

  for (const b of barbeirosConsiderar) {
    const barbeiroFull = dados.barbeiros.find((bf) => bf.id === b.id)
    if (!barbeiroFull) continue

    const periodos = barbeiroFull.availability.filter(
      (a) => a.day_of_week === estado.dia_semana && !a.is_day_off
    )

    const slotsDodia: string[] = []
    for (const periodo of periodos) {
      const slots = gerarSlotsIntervalo(periodo.starts_at, periodo.ends_at, duracaoMinutos)
      slotsDodia.push(...slots)
    }

    // Filtra horários já ocupados no banco
    const slotsLivres = await filtrarHorariosOcupados(
      dados.barbershop_id,
      b.id,
      estado.dia_escolhido!,
      slotsDodia,
      duracaoMinutos
    )

    for (const slot of slotsLivres) {
      if (!slotBarbeirosMap[slot]) slotBarbeirosMap[slot] = []
      slotBarbeirosMap[slot].push(b.id)
    }
  }

  // Ordena os slots cronologicamente
  const horarios = Object.keys(slotBarbeirosMap).sort()
  return { horarios, slotBarbeirosMap }
}

function gerarSlotsIntervalo(
  horaInicio: string,
  horaFim: string,
  duracaoMinutos: number
): string[] {
  if (!horaInicio || !horaFim) return []

  const [hI, mI] = horaInicio.split(":").map(Number)
  const [hF, mF] = horaFim.split(":").map(Number)

  if ([hI, mI, hF, mF].some(isNaN)) return []

  const slots: string[] = []
  let atual = new Date(2000, 0, 1, hI, mI)
  const fim = new Date(2000, 0, 1, hF, mF)

  while (atual < fim) {
    slots.push(
      `${String(atual.getHours()).padStart(2, "0")}:${String(atual.getMinutes()).padStart(2, "0")}`
    )
    atual = new Date(atual.getTime() + duracaoMinutos * 60000)
  }

  return slots
}

async function filtrarHorariosOcupados(
  barbershopId: string,
  barberId: string,
  data: string,
  slots: string[],
  duracaoMinutos: number
): Promise<string[]> {
  const { data: agendamentos } = await supabase
    .from("appointments")
    .select("starts_at, ends_at")
    .eq("barbershop_id", barbershopId)
    .eq("barber_id", barberId)
    .gte("starts_at", `${data}T00:00:00`)
    .lte("starts_at", `${data}T23:59:59`)
    .neq("status", "cancelled")

  if (!agendamentos?.length) return slots

  return slots.filter((slot) => {
    const slotInicio = new Date(`${data}T${slot}:00`)
    const slotFim = new Date(slotInicio.getTime() + duracaoMinutos * 60000)

    return !agendamentos.some((a) => {
      const aInicio = new Date(a.starts_at)
      const aFim = new Date(a.ends_at)
      return slotInicio < aFim && slotFim > aInicio
    })
  })
}

// ============================================
// CRIAÇÃO DO AGENDAMENTO
// ============================================

async function criarAgendamento(
  dados: DadosBarbearia,
  estado: EstadoColeta,
  nomeCliente: string,
  clienteTelefone: string
): Promise<{ success: boolean; error?: string; barbeiroNome?: string }> {
  try {
    const servico = estado.servico_escolhido!
    const dia = estado.dia_escolhido!
    const hora = estado.horario_escolhido!
    const duracaoMinutos = Number(servico.duration_min) || 30

    // Define barbeiro efetivo
    let barbeiroId: string
    let barbeiroNome: string

    if (estado.barbeiro_escolhido!.id === "sem_preferencia") {
      const barbeirosDisponiveis = estado.slot_barbeiros_map?.[hora] || []
      if (!barbeirosDisponiveis.length) {
        return { success: false, error: "Horário não está mais disponível. Por favor, escolha outro." }
      }
      const escolhido = await escolherMelhorBarbeiro(dados.barbershop_id, barbeirosDisponiveis, dia)
      barbeiroId = escolhido.id
      barbeiroNome = dados.barbeiros.find((b) => b.id === escolhido.id)?.name || "Barbeiro"
    } else {
      barbeiroId = estado.barbeiro_escolhido!.id
      barbeiroNome = estado.barbeiro_escolhido!.name
    }

    // Verifica se o slot ainda está disponível (evita race condition)
    const slotsLivres = await filtrarHorariosOcupados(
      dados.barbershop_id,
      barbeiroId,
      dia,
      [hora],
      duracaoMinutos
    )

    if (!slotsLivres.includes(hora)) {
      return {
        success: false,
        error: "Este horário acabou de ser ocupado. Por favor, escolha outro horário.",
      }
    }

    // Busca ou cria cliente na tabela customers (usando telefone do WhatsApp)
    const manualCustomerId = await buscarOuCriarClienteManual(
      dados.barbershop_id,
      nomeCliente,
      clienteTelefone
    )

    const startsAt = new Date(`${dia}T${hora}:00`)
    const endsAt = new Date(startsAt.getTime() + duracaoMinutos * 60000)

    const { error } = await supabase.from("appointments").insert({
      barbershop_id: dados.barbershop_id,
      barber_id: barbeiroId,
      service_id: servico.id,
      manual_customer_id: manualCustomerId || null,
      service_name: servico.name,
      service_price: servico.price,
      service_duration: duracaoMinutos,
      barber_name: barbeiroNome,
      customer_name: nomeCliente,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: "scheduled",
    })

    if (error) {
      console.error("[ERRO] Inserir agendamento:", error)
      return { success: false, error: "Não foi possível salvar o agendamento no sistema." }
    }

    console.log(`[AGENDAMENTO] Criado: ${servico.name} com ${barbeiroNome} em ${dia} ${hora} para ${nomeCliente}`)
    return { success: true, barbeiroNome }
  } catch (err) {
    console.error("[ERRO] criarAgendamento:", err)
    return { success: false, error: "Erro inesperado ao criar agendamento." }
  }
}

async function buscarOuCriarClienteManual(
  barbershopId: string,
  nomeCliente: string,
  telefone: string
): Promise<string | null> {
  // Tenta encontrar cliente existente pelo telefone
  const { data: existente } = await supabase
    .from("customers")
    .select("id")
    .eq("barbershop_id", barbershopId)
    .eq("phone", telefone)
    .single()

  if (existente) return existente.id

  // Cria novo cliente
  const { data: novo, error } = await supabase
    .from("customers")
    .insert({ barbershop_id: barbershopId, name: nomeCliente, phone: telefone })
    .select("id")
    .single()

  if (error) {
    console.error("[ERRO] buscarOuCriarClienteManual:", error)
    return null
  }

  return novo?.id || null
}

async function escolherMelhorBarbeiro(
  barbershopId: string,
  barbeirosIds: string[],
  dia: string
): Promise<{ id: string }> {
  // Conta agendamentos de cada barbeiro no dia e escolhe o com menos
  const contagemPorBarbeiro: Record<string, number> = {}
  for (const id of barbeirosIds) {
    contagemPorBarbeiro[id] = 0
  }

  const { data: agendamentos } = await supabase
    .from("appointments")
    .select("barber_id")
    .eq("barbershop_id", barbershopId)
    .in("barber_id", barbeirosIds)
    .gte("starts_at", `${dia}T00:00:00`)
    .lte("starts_at", `${dia}T23:59:59`)
    .neq("status", "cancelled")

  for (const a of agendamentos || []) {
    if (a.barber_id in contagemPorBarbeiro) {
      contagemPorBarbeiro[a.barber_id]++
    }
  }

  const melhor = Object.entries(contagemPorBarbeiro).sort(([, a], [, b]) => a - b)[0]
  return { id: melhor[0] }
}

// ============================================
// HAIKU — LINGUAGEM NATURAL
// ============================================

async function haikuBoasVindas(
  dados: DadosBarbearia,
  nomeCliente: string,
  historico: any[]
): Promise<string> {
  const lista = dados.servicos
    .map((s) => {
      const preco = s.price ? ` — R$ ${Number(s.price).toFixed(2).replace(".", ",")}` : ""
      const duracao = s.duration_min ? ` (${s.duration_min}min)` : ""
      return `• ${s.name}${preco}${duracao}`
    })
    .join("\n")

  const system = `Você é o assistente virtual da barbearia *${dados.barbershop_name}*.
Sua missão: recepcionar o cliente de forma calorosa e objetiva, e apresentar os serviços disponíveis.

Regras:
- Cumprimente pelo nome: ${nomeCliente}
- Use linguagem natural, informal e simpática (português brasileiro)
- Apresente a lista de serviços abaixo exatamente como fornecida
- Finalize perguntando qual serviço o cliente deseja
- Máximo 5 linhas no total (sem contar a lista)

Serviços disponíveis:
${lista}`

  const msgs = historico.filter((h) => h.role === "user" || h.role === "assistant").slice(-4)
  const messages = msgs.length > 0 ? msgs : [{ role: "user", content: `Oi, meu nome é ${nomeCliente}` }]

  return await chamarHaiku(system, messages, 350)
}

async function haikuContexto(
  dados: DadosBarbearia,
  nomeCliente: string,
  instrucao: string,
  historico: any[]
): Promise<string> {
  const lista = dados.servicos.map((s) => `• ${s.name}`).join("\n")

  const system = `Você é o assistente virtual da barbearia *${dados.barbershop_name}*.
Cliente: ${nomeCliente}

Serviços disponíveis:
${lista}

Regras:
- Linguagem informal, amigável, objetiva
- Máximo 3 frases

Instrução atual: ${instrucao}`

  const mensagensAnteriores = historico
    .filter((h) => h.role === "user" || h.role === "assistant")
    .slice(-6)

  return await chamarHaiku(system, mensagensAnteriores, 250)
}

async function interpretarEscolhaHaiku(
  texto: string,
  opcoes: Array<{ id: string; name: string }>,
  tipo: string
): Promise<string | null> {
  if (!opcoes.length) return null

  const lista = opcoes.map((o, i) => `${i + 1}. ${o.name} [id:${o.id}]`).join("\n")

  const system = `Você identifica qual opção o cliente escolheu com base no texto dele.
Responda APENAS com o ID exato (entre colchetes) da opção identificada, ou a palavra "nenhum" se não for possível identificar.
Sem explicações. Sem pontuação extra.`

  const userMsg = `Opções de ${tipo}:\n${lista}\n\nO cliente disse: "${texto}"\n\nQual ${tipo} o cliente escolheu?`

  const resposta = await chamarHaiku(system, [{ role: "user", content: userMsg }], 60)
  const trimmed = resposta.trim()

  if (trimmed === "nenhum") return null

  // Extrai ID retornado
  const encontrado = opcoes.find(
    (o) => o.id === trimmed || trimmed.includes(o.id) || normalizar(trimmed) === normalizar(o.name)
  )

  return encontrado?.id || null
}

async function chamarHaiku(
  system: string,
  messages: any[],
  maxTokens: number
): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    return "Desculpe, erro de configuração técnica."
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        system,
        messages,
      }),
    })

    const data = await response.json()

    if (data.usage) {
      console.log(
        `[CACHE] write:${data.usage.cache_creation_input_tokens || 0} read:${data.usage.cache_read_input_tokens || 0} in:${data.usage.input_tokens} out:${data.usage.output_tokens}`
      )
    }

    return data.content?.[0]?.text?.trim() || ""
  } catch (err) {
    console.error("[ERRO] chamarHaiku:", err)
    return ""
  }
}

// ============================================
// ENVIO WHATSAPP
// ============================================

async function enviarWhatsApp(
  phoneNumberId: string,
  to: string,
  texto: string
): Promise<void> {
  const token = Deno.env.get("WHATSAPP_TOKEN")
  if (!token) {
    console.error("[ERRO] WHATSAPP_TOKEN não configurado")
    return
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: texto },
        }),
      }
    )
    const result = await response.json()
    if (result.error) {
      console.error("[ERRO] enviarWhatsApp:", JSON.stringify(result.error))
    }
  } catch (err) {
    console.error("[ERRO] enviarWhatsApp:", err)
  }
}

// ============================================
// MENSAGEM DE RESUMO
// ============================================

function montarResumoAgendamento(estado: EstadoColeta): string {
  const servico = estado.servico_escolhido!
  const barbeiro = estado.barbeiro_escolhido!
  const preco = servico.price
    ? `R$ ${Number(servico.price).toFixed(2).replace(".", ",")}`
    : "Consultar"
  const dataFormatada = formatarDataExibicao(estado.dia_escolhido!)

  return `📋 *Resumo do agendamento:*\n\n• Serviço: ${servico.name} (${preco})\n• Barbeiro: ${barbeiro.name}\n• Data: ${dataFormatada}\n• Horário: ${estado.horario_escolhido}\n\nPosso confirmar seu agendamento?`
}

// ============================================
// UTILITÁRIOS DE DATA/HORA
// ============================================

function parsearDia(texto: string): { data: string; diaSemana: number; label: string } | null {
  const n = normalizar(texto)
  const hoje = new Date()

  if (n.match(/\bhoje\b/)) {
    return { data: isoDate(hoje), diaSemana: hoje.getDay(), label: "hoje" }
  }

  if (n.match(/\bamanha\b|\bamanh[aã]\b/)) {
    const amanha = addDays(hoje, 1)
    return { data: isoDate(amanha), diaSemana: amanha.getDay(), label: "amanhã" }
  }

  const mapeamento = [
    { regex: /\bdom(ingo)?\b/, dia: 0, label: "domingo" },
    { regex: /\bseg(unda)?\b/, dia: 1, label: "segunda" },
    { regex: /\bter(ca|ça)?\b/, dia: 2, label: "terça" },
    { regex: /\bqua(rta)?\b/, dia: 3, label: "quarta" },
    { regex: /\bqui(nta)?\b/, dia: 4, label: "quinta" },
    { regex: /\bsex(ta)?\b/, dia: 5, label: "sexta" },
    { regex: /\bsab(ado|ábado)?\b/, dia: 6, label: "sábado" },
  ]

  for (const m of mapeamento) {
    if (n.match(m.regex)) {
      const data = proximoDiaSemana(m.dia)
      return { data: isoDate(data), diaSemana: m.dia, label: m.label }
    }
  }

  // DD/MM ou DD/MM/YYYY
  const matchData = texto.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?/)
  if (matchData) {
    const d = parseInt(matchData[1])
    const mo = parseInt(matchData[2]) - 1
    const a = matchData[3] ? parseInt(matchData[3]) : hoje.getFullYear()
    const data = new Date(a, mo, d)
    const nomesDias = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"]
    return {
      data: isoDate(data),
      diaSemana: data.getDay(),
      label: `${nomesDias[data.getDay()]}, ${d.toString().padStart(2, "0")}/${(mo + 1).toString().padStart(2, "0")}`,
    }
  }

  return null
}

function parsearHorario(texto: string, disponiveis: string[]): string | null {
  const n = normalizar(texto)

  // Primeiro verifica se digitou número de opção (ex: "1", "2")
  const numMatch = n.match(/^(\d+)$/)
  if (numMatch) {
    const idx = parseInt(numMatch[1]) - 1
    if (idx >= 0 && idx < disponiveis.length) {
      return disponiveis[idx]
    }
  }

  // Tenta encontrar o horário no texto
  for (const h of disponiveis) {
    const semColon = h.replace(":", "")
    const comH = h.split(":")[0] + "h"
    const comHMin = h.split(":")[0] + "h" + h.split(":")[1]

    if (
      n.includes(h) ||
      n.includes(semColon) ||
      n.includes(comH) ||
      n.includes(comHMin) ||
      n.includes(h.split(":")[0] + " horas")
    ) {
      return h
    }
  }

  return null
}

function proximoDiaSemana(dia: number): Date {
  const hoje = new Date()
  const diff = dia - hoje.getDay()
  return addDays(hoje, diff <= 0 ? diff + 7 : diff)
}

function addDays(data: Date, dias: number): Date {
  const d = new Date(data)
  d.setDate(d.getDate() + dias)
  return d
}

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0]
}

function formatarDataExibicao(isoDate: string): string {
  const [ano, mes, dia] = isoDate.split("-").map(Number)
  const d = new Date(ano, mes - 1, dia)
  const nomes = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"]
  return `${nomes[d.getDay()]}, ${dia.toString().padStart(2, "0")}/${mes.toString().padStart(2, "0")}/${ano}`
}

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
}
