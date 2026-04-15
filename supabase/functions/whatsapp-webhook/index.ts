// import "jsr:@supabase/functions-js/edge-runtime.d.ts"
// import { createClient } from "jsr:@supabase/supabase-js@2"

// // ============================================
// // CONFIGURAÇÃO
// // ============================================
// const VERIFY_TOKEN = "virtual_barber_webhook_2026"
// const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || ""
// const BARBERSHOP_TEST_ID = Deno.env.get("BARBERSHOP_TEST_ID") || ""
// const TEMPO_SESSAO_HORAS = 4
// const INTERVALO_SLOT_MIN = 30   // slots sempre de 30 em 30 min
// const MARGEM_FUTURO_MIN = 15    // ignora slots com menos de 15 min no futuro

// const supabase = createClient(
//   Deno.env.get("SUPABASE_URL")!,
//   Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
// )

// // ============================================
// // TIPOS
// // ============================================
// interface Servico {
//   id: string
//   name: string
//   price: number
//   duration_min: number
// }

// interface Barbeiro {
//   id: string
//   name: string
//   description: string
//   availability: Array<{
//     day_of_week: number
//     starts_at: string | null
//     ends_at: string | null
//     is_day_off: boolean
//     use_custom_hours: boolean
//   }>
//   services: string[] // IDs dos serviços que realiza
// }

// interface OpeningHours {
//   day_of_week: number
//   opens_at: string
//   closes_at: string
//   is_open: boolean
//   period_order: number
// }

// interface DadosBarbearia {
//   barbershop_id: string
//   barbershop_name: string
//   phone: string
//   address: string
//   servicos: Servico[]
//   barbeiros: Barbeiro[]
//   opening_hours: OpeningHours[]
// }

// // ============================================
// // SERVIDOR PRINCIPAL
// // ============================================
// Deno.serve(async (req) => {
//   const url = new URL(req.url)

//   if (req.method === "GET") {
//     const mode = url.searchParams.get("hub.mode")
//     const token = url.searchParams.get("hub.verify_token")
//     const challenge = url.searchParams.get("hub.challenge")
//     if (mode === "subscribe" && token === VERIFY_TOKEN) {
//       return new Response(challenge, { status: 200 })
//     }
//     return new Response("Token invalido", { status: 403 })
//   }

//   if (req.method === "POST") {
//     try {
//       const body = await req.json()
//       const value = body.entry?.[0]?.changes?.[0]?.value

//       // Ignora status callbacks (sent, delivered, read)
//       if (value?.statuses?.length > 0) {
//         return new Response("OK", { status: 200 })
//       }

//       if (!value?.messages?.length) {
//         return new Response("OK", { status: 200 })
//       }

//       const msg = value.messages[0]
//       const from: string = msg.from
//       const phoneNumberId: string = value.metadata?.phone_number_id || value.phone_number_id
//       const nomeCliente: string = value.contacts?.[0]?.profile?.name || "Cliente"

//       if (msg.type !== "text") {
//         await enviarWhatsApp(phoneNumberId, from, "Desculpe, ainda não processo esse tipo de mensagem. Por favor, envie texto.")
//         return new Response("OK", { status: 200 })
//       }

//       const texto = msg.text.body.trim()
//       console.log(`[MSG] ${nomeCliente} (${from}): ${texto}`)

//       // Sessão
//       const { conversa, isNova } = await getOuCriarConversa(phoneNumberId, from)
//       const historico: any[] = conversa.historic as any[]

//       // Dados da barbearia (sempre fresh)
//       const dados = await buscarDadosBarbearia()
//       if (!dados) {
//         await enviarWhatsApp(phoneNumberId, from, "Estamos com dificuldades técnicas. Tente novamente em instantes.")
//         return new Response("OK", { status: 200 })
//       }

//       // Processa mensagem com Haiku
//       const { resposta, novoStatus } = await processarMensagem(
//         texto, nomeCliente, from, dados, historico, isNova
//       )

//       // Salva histórico (apenas user/assistant, máx 8 mensagens = 4 trocas)
//       const mensagensAnteriores = historico
//         .filter((h: any) => h.role === "user" || h.role === "assistant")
//       const historicoFinal = [
//         ...mensagensAnteriores,
//         { role: "user", content: texto },
//         { role: "assistant", content: resposta },
//       ].slice(-8)

//       await atualizarHistorico(conversa.id, historicoFinal, novoStatus)
//       await enviarWhatsApp(phoneNumberId, from, resposta)
//       console.log(`[RESP] → ${from}: ${resposta.substring(0, 100)}...`)

//       return new Response("OK", { status: 200 })
//     } catch (error) {
//       console.error("[ERRO CRÍTICO]", error)
//       return new Response("OK", { status: 200 })
//     }
//   }

//   return new Response("Metodo nao suportado", { status: 405 })
// })

// // ============================================
// // GESTÃO DE SESSÃO
// // ============================================
// async function getOuCriarConversa(
//   phoneNumberId: string,
//   clienteNumero: string
// ): Promise<{ conversa: any; isNova: boolean }> {
//   if (!BARBERSHOP_TEST_ID) throw new Error("BARBERSHOP_TEST_ID não configurado")

//   const { data: existente } = await supabase
//     .from("conversations_chatbot")
//     .select("*")
//     .eq("barbershop_id", BARBERSHOP_TEST_ID)
//     .eq("client_phone_number_id", clienteNumero)
//     .eq("status", "em_andamento")
//     .order("updated_at", { ascending: false })
//     .limit(1)
//     .single()

//   if (existente) {
//     const diffHoras = (Date.now() - new Date(existente.updated_at).getTime()) / 3600000
//     if (diffHoras < TEMPO_SESSAO_HORAS) {
//       console.log(`[SESSÃO] Ativa (${diffHoras.toFixed(1)}h atrás)`)
//       return { conversa: existente, isNova: false }
//     }
//     console.log(`[SESSÃO] Expirada (${diffHoras.toFixed(1)}h). Recriando...`)
//     await supabase.from("conversations_chatbot").delete().eq("id", existente.id)
//   }

//   const { data: nova, error } = await supabase
//     .from("conversations_chatbot")
//     .insert({
//       barbershop_id: BARBERSHOP_TEST_ID,
//       barbershop_phone_number_id: phoneNumberId,
//       client_phone_number_id: clienteNumero,
//       historic: [],
//       status: "em_andamento",
//     })
//     .select()
//     .single()

//   if (error || !nova) throw new Error("Não foi possível criar conversa")
//   console.log(`[SESSÃO] Nova: ${nova.id}`)
//   return { conversa: nova, isNova: true }
// }

// async function atualizarHistorico(conversaId: string, historico: any[], status: string): Promise<void> {
//   const { error } = await supabase
//     .from("conversations_chatbot")
//     .update({ historic: historico, status, updated_at: new Date().toISOString() })
//     .eq("id", conversaId)
//   if (error) console.error("[ERRO] atualizarHistorico:", error)
// }

// // ============================================
// // DADOS DA BARBEARIA
// // ============================================
// async function buscarDadosBarbearia(): Promise<DadosBarbearia | null> {
//   const { data: barbearia } = await supabase
//     .from("barbershops")
//     .select("id, name, phone, addresses(city, neighborhood, street, number)")
//     .eq("id", BARBERSHOP_TEST_ID)
//     .single()

//   if (!barbearia) {
//     console.error("[ERRO] Barbearia não encontrada:", BARBERSHOP_TEST_ID)
//     return null
//   }

//   const [{ data: servicos }, { data: barbeiros }, { data: openingHours }] = await Promise.all([
//     supabase
//       .from("services")
//       .select("id, name, price, duration_min")
//       .eq("barbershop_id", BARBERSHOP_TEST_ID)
//       .eq("is_active", true)
//       .order("name"),
//     supabase
//       .from("barbers")
//       .select(`id, name, description,
//         barber_availability(day_of_week, starts_at, ends_at, is_day_off, use_custom_hours),
//         barber_services(service_id)`)
//       .eq("barbershop_id", BARBERSHOP_TEST_ID)
//       .eq("is_active", true),
//     supabase
//       .from("opening_hours")
//       .select("day_of_week, opens_at, closes_at, is_open, period_order")
//       .eq("barbershop_id", BARBERSHOP_TEST_ID)
//       .order("day_of_week")
//       .order("period_order"),
//   ])

//   const addr = barbearia.addresses?.[0]
//   return {
//     barbershop_id: barbearia.id,
//     barbershop_name: barbearia.name,
//     phone: barbearia.phone || "",
//     address: addr ? `${addr.street}, ${addr.number} - ${addr.neighborhood}, ${addr.city}` : "",
//     servicos: (servicos || []) as Servico[],
//     barbeiros: (barbeiros || []).map((b: any) => ({
//       id: b.id,
//       name: b.name,
//       description: b.description || "",
//       availability: b.barber_availability || [],
//       services: (b.barber_services || []).map((s: any) => s.service_id),
//     })),
//     opening_hours: (openingHours || []) as OpeningHours[],
//   }
// }

// // Computa agenda dos próximos 7 dias com uma única query ao banco
// async function computarAgendaSemana(dados: DadosBarbearia): Promise<string> {
//   const hoje = new Date()
//   const fimPeriodo = addDays(hoje, 8)

//   // Uma query busca todos os agendamentos do período
//   const { data: todosAgend, error: erroAgend } = await supabase
//     .from("appointments")
//     .select("barber_id, starts_at, ends_at")
//     .eq("barbershop_id", dados.barbershop_id)
//     .gte("starts_at", hoje.toISOString())
//     .lte("starts_at", fimPeriodo.toISOString())
//     .not("status", "in", "(cancelled_by_customer,cancelled_by_barbershop)")

//   // Mapa: barber_id → lista de agendamentos
//   const agendsPorBarbeiro: Record<string, Array<{ starts_at: string; ends_at: string }>> = {}
//   for (const a of todosAgend || []) {
//     if (a.barber_id) {
//       if (!agendsPorBarbeiro[a.barber_id]) agendsPorBarbeiro[a.barber_id] = []
//       agendsPorBarbeiro[a.barber_id].push(a)
//     }
//   }

//   const nomesDias = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"]
//   const linhas: string[] = ["=== AGENDA (próx. 7 dias | faixas de 30 em 30 min) ==="]

//   for (let i = 0; i < 7; i++) {
//     const dia = addDays(hoje, i)
//     const dataISO = isoDate(dia)
//     const diaSemana = dia.getDay()
//     const dataFmt = `${nomesDias[diaSemana]} ${dia.getDate().toString().padStart(2, "0")}/${(dia.getMonth() + 1).toString().padStart(2, "0")} [${dataISO}]`

//     const linhasBarbeiros: string[] = []

//     for (const barbeiro of dados.barbeiros) {
//       const periodos = barbeiro.availability.filter(
//         (a) => a.day_of_week === diaSemana && !a.is_day_off
//       )

//       if (!periodos.length) continue

//       let slots: string[] = []
//       for (const p of periodos) {
//         if (p.starts_at && p.ends_at) {
//           slots.push(...gerarSlotsIntervalo(p.starts_at, p.ends_at, INTERVALO_SLOT_MIN))
//         } else {
//           // Barbeiro sem horário personalizado: usa horário da barbearia
//           const horasBarbearia = dados.opening_hours.filter(
//             (h) => h.day_of_week === diaSemana && h.is_open
//           )
//           for (const h of horasBarbearia) {
//             slots.push(...gerarSlotsIntervalo(h.opens_at, h.closes_at, INTERVALO_SLOT_MIN))
//           }
//         }
//       }

//       // Para hoje: descarta slots com menos de MARGEM_FUTURO_MIN minutos
//       if (i === 0) {
//         const limite = new Date(Date.now() + MARGEM_FUTURO_MIN * 60000)
//         slots = slots.filter((s) => new Date(`${dataISO}T${s}:00`) >= limite)
//       }

//       // Filtra slots ocupados usando os dados em memória
//       const agendsBarbeiro = agendsPorBarbeiro[barbeiro.id] || []
//       const livres = slots.filter((slot) => {
//         const inicio = new Date(`${dataISO}T${slot}:00`)
//         const fim = new Date(inicio.getTime() + INTERVALO_SLOT_MIN * 60000)
//         return !agendsBarbeiro.some((a) => inicio < new Date(a.ends_at) && fim > new Date(a.starts_at))
//       })

//       if (livres.length > 0) {
//         const servicosNomes = dados.servicos
//           .filter((s) => barbeiro.services.includes(s.id))
//           .map((s) => s.name)
//           .join(", ")
//         linhasBarbeiros.push(
//           `  ${barbeiro.name} [id:${barbeiro.id}] (faz: ${servicosNomes}): ${slotsParaFaixas(livres)}`
//         )
//       }
//     }

//     // Só inclui o dia se houver pelo menos um barbeiro disponível
//     if (linhasBarbeiros.length > 0) {
//       linhas.push(`\n${dataFmt}:\n${linhasBarbeiros.join("\n")}`)
//     }
//   }

//   return linhas.join("\n")
// }

// // ============================================
// // PROCESSAMENTO — HAIKU GERENCIA O FLUXO
// // ============================================
// async function processarMensagem(
//   texto: string,
//   nomeCliente: string,
//   clienteTelefone: string,
//   dados: DadosBarbearia,
//   historico: any[],
//   isNova: boolean
// ): Promise<{ resposta: string; novoStatus: string }> {
//   // Prepara contexto em paralelo
//   const [agendaSemana, agendamentosFuturos] = await Promise.all([
//     computarAgendaSemana(dados),
//     buscarAgendamentosFuturos(dados.barbershop_id, clienteTelefone),
//   ])

//   const agendFmt =
//     agendamentosFuturos.length > 0
//       ? agendamentosFuturos
//           .map((a, i) => `${i + 1}. [id:${a.id}] ${a.servico} com ${a.barbeiro} — ${a.data} às ${a.hora}`)
//           .join("\n")
//       : "Nenhum agendamento futuro."

//   const system = montarSystemPrompt(dados, nomeCliente, agendaSemana, agendFmt, isNova)

//   // Histórico de conversa (só user/assistant)
//   const mensagensAnteriores = historico
//     .filter((h: any) => h.role === "user" || h.role === "assistant")
//     .slice(-6)

//   const messages = [...mensagensAnteriores, { role: "user", content: texto }]

//   const respostaHaiku = await chamarHaiku(system, messages, 300)

//   if (!respostaHaiku) {
//     return { resposta: "Desculpe, tive um problema técnico. Pode repetir?", novoStatus: "em_andamento" }
//   }

//   // ---- Detecta ação AGENDAR ----
//   const agendarMatch = respostaHaiku.match(/AGENDAR:\s*(\{[\s\S]*?\})/)
//   if (agendarMatch) {
//     try {
//       const agData = JSON.parse(agendarMatch[1])
//       console.log("[AGENDAR] Dados recebidos do Haiku:", JSON.stringify(agData))

//       const resultado = await criarAgendamento(dados, agData, nomeCliente, clienteTelefone)

//       if (resultado.success) {
//         const dataFmt = formatarDataExibicao(agData.data)
//         return {
//           resposta: `✅ *Agendamento confirmado!*\n\n• Serviço: ${agData.servico_nome}\n• Barbeiro: ${resultado.barbeiroNome}\n• Data: ${dataFmt}\n• Horário: ${agData.hora}\n\nTe esperamos! Se precisar cancelar é só me chamar. 💈`,
//           novoStatus: "concluida",
//         }
//       } else {
//         console.error("[ERRO] criarAgendamento:", resultado.error)
//         return {
//           resposta: `Desculpe, não consegui confirmar o agendamento. 😔\n\n${resultado.error}\n\nQuer tentar outro horário?`,
//           novoStatus: "em_andamento",
//         }
//       }
//     } catch (err) {
//       console.error("[ERRO] parsear AGENDAR:", err, "\nTexto:", agendarMatch[1])
//       return {
//         resposta: "Erro técnico ao confirmar. Pode tentar novamente?",
//         novoStatus: "em_andamento",
//       }
//     }
//   }

//   // ---- Detecta ação CANCELAR ----
//   const cancelarMatch = respostaHaiku.match(/CANCELAR:\s*(\{[\s\S]*?\})/)
//   if (cancelarMatch) {
//     try {
//       const { agendamento_id } = JSON.parse(cancelarMatch[1])

//       const { error } = await supabase
//         .from("appointments")
//         .update({ status: "cancelled_by_customer", updated_at: new Date().toISOString() })
//         .eq("id", agendamento_id)
//         .eq("barbershop_id", dados.barbershop_id) // segurança extra

//       if (error) throw error

//       return {
//         resposta: "✅ Agendamento cancelado com sucesso! Se quiser fazer um novo, é só me chamar. 😊",
//         novoStatus: "concluida",
//       }
//     } catch (err) {
//       console.error("[ERRO] cancelar:", err)
//       return {
//         resposta: "Não consegui cancelar. Por favor, entre em contato conosco diretamente.",
//         novoStatus: "em_andamento",
//       }
//     }
//   }

//   // Resposta normal do Haiku
//   return { resposta: respostaHaiku, novoStatus: "em_andamento" }
// }

// function montarSystemPrompt(
//   dados: DadosBarbearia,
//   nomeCliente: string,
//   agendaSemana: string,
//   agendamentosFuturos: string,
//   isNova: boolean
// ): string {
//   const listaServicos = dados.servicos
//     .map((s) => {
//       const preco = s.price ? `R$ ${Number(s.price).toFixed(2).replace(".", ",")}` : ""
//       return `• ${s.name} [id:${s.id}] | ${preco} | ${s.duration_min}min`
//     })
//     .join("\n")

//   const instrucao = isNova
//     ? `Cumprimente ${nomeCliente} de forma calorosa e apresente os serviços disponíveis.`
//     : `Continue a conversa com ${nomeCliente} de onde parou.`

//   return `Você é o assistente virtual de agendamento da barbearia *${dados.barbershop_name}*.
// Cliente: ${nomeCliente}

// === SERVIÇOS ===
// ${listaServicos}

// ${agendaSemana}

// === AGENDAMENTOS FUTUROS DO CLIENTE (para cancelamento) ===
// ${agendamentosFuturos}

// === INSTRUÇÕES ===
// 1. ${instrucao}
// 2. Colete: serviço, data, barbeiro e horário. Use APENAS barbeiros e dias da AGENDA. Os horários são faixas de 30 em 30 min (ex: 09:00-11:00 = slots disponíveis: 09:00, 09:30, 10:00, 10:30, 11:00). Ao confirmar, use sempre um horário exato de 30 em 30 min.
// 3. Cada barbeiro realiza apenas os serviços indicados na agenda — respeite isso.
// 4. Se o cliente não tiver preferência de barbeiro, você escolhe qualquer um que tenha o horário disponível.
// 5. Quando tiver todos os dados, mostre o resumo e pergunte "Posso confirmar?".
// 6. Após o cliente confirmar (sim / pode ser / ok / isso), responda SOMENTE com esta linha (sem mais nada):
//    AGENDAR:{"servico_id":"ID","servico_nome":"NOME","barbeiro_id":"ID","barbeiro_nome":"NOME","data":"YYYY-MM-DD","hora":"HH:MM"}
// 7. Para cancelamento: quando o cliente escolher qual cancelar, responda SOMENTE com:
//    CANCELAR:{"agendamento_id":"ID"}
// 8. O cliente pode mudar qualquer dado a qualquer momento antes de confirmar — adapte-se naturalmente.
// 9. Linguagem informal e objetiva (português BR). Respostas curtas, máx 5 linhas (exceto ao listar opções).
// 10. Nunca invente horários ou barbeiros. Se não há disponibilidade, diga claramente.`
// }

// // ============================================
// // HAIKU
// // ============================================
// async function chamarHaiku(system: string, messages: any[], maxTokens: number): Promise<string> {
//   if (!ANTHROPIC_API_KEY) {
//     console.error("[ERRO] ANTHROPIC_API_KEY não configurado")
//     return ""
//   }

//   try {
//     const response = await fetch("https://api.anthropic.com/v1/messages", {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         "x-api-key": ANTHROPIC_API_KEY,
//         "anthropic-version": "2023-06-01",
//       },
//       body: JSON.stringify({
//         model: "claude-haiku-4-5-20251001",
//         max_tokens: maxTokens,
//         system,
//         messages,
//       }),
//     })

//     const data = await response.json()

//     if (data.usage) {
//       console.log(`[TOKENS] in:${data.usage.input_tokens} out:${data.usage.output_tokens}`)
//     }

//     if (!data.content?.[0]?.text) {
//       console.error("[ERRO] Resposta inesperada Haiku:", JSON.stringify(data))
//       return ""
//     }

//     return data.content[0].text.trim()
//   } catch (err) {
//     console.error("[ERRO] chamarHaiku:", err)
//     return ""
//   }
// }

// // ============================================
// // AGENDAMENTOS
// // ============================================
// async function criarAgendamento(
//   dados: DadosBarbearia,
//   agData: {
//     servico_id: string
//     servico_nome: string
//     barbeiro_id: string
//     barbeiro_nome: string
//     data: string
//     hora: string
//   },
//   nomeCliente: string,
//   clienteTelefone: string
// ): Promise<{ success: boolean; error?: string; barbeiroNome?: string }> {
//   try {
//     // Valida serviço e barbeiro nos dados carregados
//     const servico = dados.servicos.find((s) => s.id === agData.servico_id)
//     if (!servico) return { success: false, error: "Serviço não reconhecido. Por favor, escolha novamente." }

//     const barbeiro = dados.barbeiros.find((b) => b.id === agData.barbeiro_id)
//     if (!barbeiro) return { success: false, error: "Barbeiro não reconhecido. Por favor, escolha novamente." }

//     const duracaoMinutos = Number(servico.duration_min) || 30
//     const slotInicio = new Date(`${agData.data}T${agData.hora}:00`)
//     const slotFim = new Date(slotInicio.getTime() + duracaoMinutos * 60000)

//     if (isNaN(slotInicio.getTime())) {
//       return { success: false, error: "Data ou horário inválido. Por favor, escolha novamente." }
//     }

//     // Anti-race condition: verifica se o slot ainda está livre
//     const { data: conflito } = await supabase
//       .from("appointments")
//       .select("id")
//       .eq("barbershop_id", dados.barbershop_id)
//       .eq("barber_id", barbeiro.id)
//       .lt("starts_at", slotFim.toISOString())
//       .gt("ends_at", slotInicio.toISOString())
//       .not("status", "in", "(cancelled_by_customer,cancelled_by_barbershop)")
//       .limit(1)

//     if (conflito && conflito.length > 0) {
//       return { success: false, error: "Este horário acabou de ser ocupado. Por favor, escolha outro." }
//     }

//     // Busca ou cria cliente pelo telefone
//     const manualCustomerId = await buscarOuCriarClienteManual(
//       dados.barbershop_id,
//       nomeCliente,
//       clienteTelefone
//     )

//     // Cria agendamento
//     const { error } = await supabase.from("appointments").insert({
//       barbershop_id: dados.barbershop_id,
//       barber_id: barbeiro.id,
//       service_id: servico.id,
//       manual_customer_id: manualCustomerId || null,
//       service_name: servico.name,
//       service_price: servico.price,
//       service_duration: duracaoMinutos,
//       barber_name: barbeiro.name,
//       customer_name: nomeCliente,
//       starts_at: slotInicio.toISOString(),
//       ends_at: slotFim.toISOString(),
//       status: "scheduled",
//     })

//     if (error) {
//       console.error("[ERRO] insert appointment:", error)
//       return { success: false, error: "Não foi possível salvar o agendamento. Tente novamente." }
//     }

//     console.log(`[AGENDAMENTO] OK | ${servico.name} | ${barbeiro.name} | ${agData.data} ${agData.hora} | ${nomeCliente}`)
//     return { success: true, barbeiroNome: barbeiro.name }
//   } catch (err) {
//     console.error("[ERRO] criarAgendamento:", err)
//     return { success: false, error: "Erro inesperado ao criar agendamento." }
//   }
// }

// async function buscarAgendamentosFuturos(
//   barbershopId: string,
//   telefone: string
// ): Promise<Array<{ id: string; servico: string; barbeiro: string; data: string; hora: string }>> {
//   const { data: cliente } = await supabase
//     .from("customers")
//     .select("id")
//     .eq("barbershop_id", barbershopId)
//     .eq("phone", telefone)
//     .single()

//   if (!cliente) return []

//   const { data: agendamentos } = await supabase
//     .from("appointments")
//     .select("id, service_name, barber_name, starts_at")
//     .eq("barbershop_id", barbershopId)
//     .eq("manual_customer_id", cliente.id)
//     .gte("starts_at", new Date().toISOString())
//     .not("status", "in", "(cancelled_by_customer,cancelled_by_barbershop)")
//     .order("starts_at", { ascending: true })
//     .limit(5)

//   return (agendamentos || []).map((a) => {
//     const dt = new Date(a.starts_at)
//     return {
//       id: a.id,
//       servico: a.service_name || "Serviço",
//       barbeiro: a.barber_name || "Barbeiro",
//       data: `${dt.getDate().toString().padStart(2, "0")}/${(dt.getMonth() + 1).toString().padStart(2, "0")}/${dt.getFullYear()}`,
//       hora: `${dt.getHours().toString().padStart(2, "0")}:${dt.getMinutes().toString().padStart(2, "0")}`,
//     }
//   })
// }

// async function buscarOuCriarClienteManual(
//   barbershopId: string,
//   nomeCliente: string,
//   telefone: string
// ): Promise<string | null> {
//   const { data: existente } = await supabase
//     .from("customers")
//     .select("id")
//     .eq("barbershop_id", barbershopId)
//     .eq("phone", telefone)
//     .single()

//   if (existente) return existente.id

//   const { data: novo, error } = await supabase
//     .from("customers")
//     .insert({ barbershop_id: barbershopId, name: nomeCliente, phone: telefone })
//     .select("id")
//     .single()

//   if (error) {
//     console.error("[ERRO] buscarOuCriarClienteManual:", error)
//     return null
//   }

//   return novo?.id || null
// }

// // ============================================
// // ENVIO WHATSAPP
// // ============================================
// async function enviarWhatsApp(phoneNumberId: string, to: string, texto: string): Promise<void> {
//   const token = Deno.env.get("WHATSAPP_TOKEN")
//   if (!token) {
//     console.error("[ERRO] WHATSAPP_TOKEN não configurado")
//     return
//   }

//   try {
//     const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
//       method: "POST",
//       headers: {
//         Authorization: `Bearer ${token}`,
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify({
//         messaging_product: "whatsapp",
//         to,
//         type: "text",
//         text: { body: texto },
//       }),
//     })
//     const result = await response.json()
//     if (result.error) console.error("[ERRO] enviarWhatsApp:", JSON.stringify(result.error))
//   } catch (err) {
//     console.error("[ERRO] enviarWhatsApp:", err)
//   }
// }

// // ============================================
// // UTILITÁRIOS
// // ============================================
// function slotsParaFaixas(slots: string[]): string {
//   if (!slots.length) return ""
//   const resultado: string[] = []
//   let inicio = slots[0]
//   let ultimo = slots[0]

//   for (let i = 1; i < slots.length; i++) {
//     const [hA, mA] = ultimo.split(":").map(Number)
//     const [hB, mB] = slots[i].split(":").map(Number)
//     if (hB * 60 + mB - (hA * 60 + mA) === 30) {
//       ultimo = slots[i]
//     } else {
//       resultado.push(inicio === ultimo ? inicio : `${inicio}-${ultimo}`)
//       inicio = slots[i]
//       ultimo = slots[i]
//     }
//   }
//   resultado.push(inicio === ultimo ? inicio : `${inicio}-${ultimo}`)
//   return resultado.join(" ")
// }

// function gerarSlotsIntervalo(horaInicio: string, horaFim: string, intervaloMin: number): string[] {
//   if (!horaInicio || !horaFim) return []
//   const [hI, mI] = horaInicio.split(":").map(Number)
//   const [hF, mF] = horaFim.split(":").map(Number)
//   if ([hI, mI, hF, mF].some(isNaN)) return []

//   const slots: string[] = []
//   let atual = new Date(2000, 0, 1, hI, mI)
//   const fim = new Date(2000, 0, 1, hF, mF)

//   while (atual < fim) {
//     slots.push(
//       `${String(atual.getHours()).padStart(2, "0")}:${String(atual.getMinutes()).padStart(2, "0")}`
//     )
//     atual = new Date(atual.getTime() + intervaloMin * 60000)
//   }

//   return slots
// }

// function addDays(data: Date, dias: number): Date {
//   const d = new Date(data)
//   d.setDate(d.getDate() + dias)
//   return d
// }

// function isoDate(d: Date): string {
//   return d.toISOString().split("T")[0]
// }

// function formatarDataExibicao(iso: string): string {
//   const [ano, mes, dia] = iso.split("-").map(Number)
//   const d = new Date(ano, mes - 1, dia)
//   const nomes = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"]
//   return `${nomes[d.getDay()]}, ${dia.toString().padStart(2, "0")}/${mes.toString().padStart(2, "0")}/${ano}`
// }



import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const VERIFY_TOKEN = "virtual_barber_webhook_2026"
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
)

// ============================================
// LOOKUP: phoneNumberId → barbershop
// ============================================

interface BarbershopInfo {
  id: string
  name: string
}

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutos

const BARBERSHOP_CACHE = new Map<string, { data: BarbershopInfo; at: number }>()

async function getBarbershopByPhone(phoneNumberId: string): Promise<BarbershopInfo | null> {
  const cached = BARBERSHOP_CACHE.get(phoneNumberId)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data
  const { data, error } = await supabase
    .from("barbershops")
    .select("id, name")
    .eq("whatsapp_phone_number_id", phoneNumberId)
    .single()
  if (error || !data) {
    console.error("[ERRO] getBarbershopByPhone:", phoneNumberId, JSON.stringify(error))
    return null
  }
  BARBERSHOP_CACHE.set(phoneNumberId, { data: data as BarbershopInfo, at: Date.now() })
  return data as BarbershopInfo
}

// ============================================
// SERVIÇOS (cache por barbearia)
// ============================================

interface Servico {
  id: string
  name: string
  description?: string | null
  price: number
  duration_min: number
}

const SERVICOS_CACHE = new Map<string, { data: Servico[]; at: number }>()

async function getServicos(barbershopId: string): Promise<Servico[]> {
  const cached = SERVICOS_CACHE.get(barbershopId)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data
  const { data, error } = await supabase
    .from("services")
    .select("id, name, price, duration_min, description")
    .eq("barbershop_id", barbershopId)
    .eq("is_active", true)
    .order("name")
  if (error) console.error("[ERRO] getServicos:", JSON.stringify(error))
  const servicos = (data || []) as Servico[]
  SERVICOS_CACHE.set(barbershopId, { data: servicos, at: Date.now() })
  return servicos
}

// ============================================
// HORÁRIOS DE FUNCIONAMENTO (cache por barbearia)
// ============================================

interface OpeningHour {
  day_of_week: number
  opens_at: string
  closes_at: string
  period_order: number
}

const OPENING_HOURS_CACHE = new Map<string, { data: OpeningHour[]; at: number }>()

async function getOpeningHours(barbershopId: string): Promise<OpeningHour[]> {
  const cached = OPENING_HOURS_CACHE.get(barbershopId)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data
  const { data, error } = await supabase
    .from("opening_hours")
    .select("day_of_week, opens_at, closes_at, period_order")
    .eq("barbershop_id", barbershopId)
    .eq("is_open", true)
    .order("period_order")
  if (error) console.error("[ERRO] getOpeningHours:", JSON.stringify(error))
  const hours = (data || []) as OpeningHour[]
  OPENING_HOURS_CACHE.set(barbershopId, { data: hours, at: Date.now() })
  return hours
}

// Retorna o horário atual em Brasília (UTC-3)
function agoraBrasilia(): { date: Date; timeStr: string } {
  const utc = new Date()
  const date = new Date(utc.getTime() - 3 * 60 * 60 * 1000)
  const timeStr = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
  return { date, timeStr }
}

interface DiaDisponivel {
  label: string  // ex: "Hoje (14/04)", "Amanhã (15/04)", "Seg (21/04)"
  value: string  // ex: "14/04"
}

async function getDiasDisponiveis(barbershopId: string): Promise<DiaDisponivel[]> {
  const openingHours = await getOpeningHours(barbershopId)

  // Agrupa períodos por day_of_week
  const porDia = new Map<number, OpeningHour[]>()
  for (const oh of openingHours) {
    if (!porDia.has(oh.day_of_week)) porDia.set(oh.day_of_week, [])
    porDia.get(oh.day_of_week)!.push(oh)
  }

  const { date: hoje, timeStr: horaAtual } = agoraBrasilia()
  const SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
  const dias: DiaDisponivel[] = []

  for (let i = 0; i < 7; i++) {
    const data = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() + i))
    const jsDay = data.getUTCDay()           // 0=Dom ... 6=Sáb (igual ao banco)
    const periodos = porDia.get(jsDay) || []
    if (periodos.length === 0) continue

    // Para hoje: só inclui se algum período ainda não fechou
    if (i === 0) {
      const aindaAberto = periodos.some(p => p.closes_at > horaAtual)
      if (!aindaAberto) continue
    }

    const dia = String(data.getUTCDate()).padStart(2, '0')
    const mes = String(data.getUTCMonth() + 1).padStart(2, '0')
    const value = `${dia}/${mes}`

    let label: string
    if (i === 0)      label = `Hoje (${value})`
    else if (i === 1) label = `Amanhã (${value})`
    else              label = `${SEMANA[jsDay]} (${value})`

    dias.push({ label, value })
  }

  return dias
}

const BARBEIROS_MOCK = [
  { id: "1", name: "Carlos", rating: 4.9, especialidade: "Degradê" },
  { id: "2", name: "Rafael", rating: 4.8, especialidade: "Barba" },
  { id: "3", name: "Eduardo", rating: 4.9, especialidade: "Platinados" },
  { id: "4", name: "Lucas", rating: 4.7, especialidade: "Cortes Sociais" },
  { id: "5", name: "Gustavo", rating: 4.8, especialidade: "Navalha" },
  { id: "6", name: "André", rating: 4.6, especialidade: "Cortes Infantis" },
  { id: "7", name: "Mateus", rating: 4.5, especialidade: "Aprendiz" },
  { id: "8", name: "Bruno", rating: 4.7, especialidade: "Finalização" },
  { id: "9", name: "Felipe", rating: 4.8, especialidade: "Terapia" },
  { id: "10", name: "Rodrigo", rating: 4.9, especialidade: "Militares" },
  { id: "11", name: "Samuel", rating: 4.7, especialidade: "UnderCut" },
  { id: "12", name: "Thiago", rating: 4.8, especialidade: "Barba Desenhada" },
  { id: "13", name: "Diego", rating: 4.6, especialidade: "Cabelo Cacheado" },
  { id: "14", name: "Henrique", rating: 4.9, especialidade: "Platinado" },
  { id: "15", name: "Leonardo", rating: 4.7, especialidade: "Tesoura" },
  { id: "16", name: "Vinicius", rating: 4.8, especialidade: "Máquina" },
  { id: "17", name: "Paulo", rating: 4.6, especialidade: "Mechas" },
  { id: "18", name: "Marcelo", rating: 4.7, especialidade: "Coloração" },
  { id: "19", name: "Renato", rating: 4.8, especialidade: "Luzes" },
  { id: "20", name: "Fábio", rating: 4.9, especialidade: "Premium" }
]

interface EstadoTeste {
  etapa: 'inicio' | 'servico' | 'dia' | 'barbeiro' | 'horario' | 'confirmacao' | 'informacoes' | 'listar_agendamentos'
  servico?: Servico
  dia?: string
  barbeiro?: typeof BARBEIROS_MOCK[0]
  horario?: string
  paginaServicos: number
  paginaBarbeiros: number
  jaEnviouBoasVindas: boolean
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
      return new Response(challenge, { status: 200 })
    }
    return new Response("Token invalido", { status: 403 })
  }

  if (req.method === "POST") {
    try {
      const body = await req.json()
      const value = body.entry?.[0]?.changes?.[0]?.value

      //VERIFICA SE É SÓ STATUS (ex: mensagem entregue) — se for, ignora
      if (value?.statuses?.length > 0) {
        return new Response("OK", { status: 200 })
      }

      //VERIFICA SE TEM MENSAGEM — se não tiver, ignora
      if (!value?.messages?.length) {
        return new Response("OK", { status: 200 })
      }

      const msg = value.messages[0] //OBJETO DA MENSAGEM DO CLIENTE
      const from = msg.from //NUMERO DO CLIENTE
      const phoneNumberId = value.metadata?.phone_number_id || value.phone_number_id //ID DO WHATSAPP DA BARBEARIA
      const nomeCliente = value.contacts?.[0]?.profile?.name || "Cliente" //NOME DO CLIENTE

      // IDENTIFICA A BARBEARIA PELO phoneNumberId
      const barbearia = await getBarbershopByPhone(phoneNumberId)
      if (!barbearia) {
        console.error(`[ERRO] Barbearia não encontrada para phoneNumberId: ${phoneNumberId}`)
        return new Response("OK", { status: 200 })
      }
      const barbershopId = barbearia.id
      const nomeBarbearia = barbearia.name

      let texto = msg.text?.body?.trim() || ""

      //DETECTA SE É INTERAÇÃO (clique em botão ou lista)
      const isInteractive = msg.type === "interactive"

      //SE FOR INTERAÇÃO, PEGA O ID DO BOTÃO CLICADO OU OPÇÃO DE LISTA, CASO EXISTA
      if (isInteractive) {
        texto = msg.interactive?.button_reply?.id ||
                msg.interactive?.list_reply?.id ||
                texto
      }

      console.log(`[MSG] ${nomeCliente}: "${texto}" | tipo: ${msg.type} | barbearia: ${nomeBarbearia}`)

      // BUSCA O ESTADO DA CONVERSA NA TABELA conversations_chatbot DO BANCO DE DADOS
      let estado = await buscarEstadoConversa(from)

      console.log(`[ESTADO] etapa: ${estado.etapa}, jaEnviouBoasVindas: ${estado.jaEnviouBoasVindas}`)

      // SÓ ENVIA BOAS-VINDAS SE:
      // 1. Ainda não enviou E
      // 2. NÃO é uma interação (clique em botão)
      if (!estado.jaEnviouBoasVindas && !isInteractive) {
        console.log(`[ENVIO] Primeira interação - enviando botão`)
        await enviarBotoesIniciais(phoneNumberId, nomeBarbearia, from, nomeCliente)

        estado.jaEnviouBoasVindas = true
        estado.etapa = 'inicio'
        await salvarEstadoConversa(from, estado, phoneNumberId, barbershopId)
        return new Response("OK", { status: 200 })
      }

      // Se é interação mas ainda não tem estado inicializado, inicializa
      if (isInteractive && !estado.jaEnviouBoasVindas) {
        estado.jaEnviouBoasVindas = true
        estado.etapa = 'inicio'
      }

      // Processa resposta
      const resposta = await processarComBotoes(texto, nomeCliente, estado, phoneNumberId, from, barbershopId)

      // Salva estado atualizado
      await salvarEstadoConversa(from, estado, phoneNumberId, barbershopId)

      // Envia resposta se houver
      if (resposta) {
        await enviarWhatsApp(phoneNumberId, from, resposta)
      }
      console.log(`[RESP] → ${from}`)

      return new Response("OK", { status: 200 })
    } catch (error) {
      console.error("[ERRO]", error)
      return new Response("OK", { status: 200 })
    }
  }

  return new Response("Metodo nao suportado", { status: 405 })
})

// ============================================
// GESTÃO DE ESTADO
// ============================================

async function buscarEstadoConversa(clienteNumero: string): Promise<EstadoTeste> {
  const { data } = await supabase
    .from("conversations_chatbot")
    .select("historic")
    .eq("client_phone_number_id", clienteNumero)
    .eq("status", "em_andamento")
    .order("updated_at", { ascending: false })
    .limit(1)
    .single()

  if (data?.historic && data.historic.length > 0) {
    // 🔥 CORREÇÃO: busca do FIM para o INÍCIO (estado mais recente)
    const ultimoEstado = [...data.historic].reverse().find((h: any) => h.tipo === "estado_teste")
    if (ultimoEstado) {
      return ultimoEstado.content as EstadoTeste
    }
  }

  return { etapa: 'inicio', paginaServicos: 1, paginaBarbeiros: 1, jaEnviouBoasVindas: false }
}

async function salvarEstadoConversa(clienteNumero: string, estado: EstadoTeste, phoneNumberId: string, barbershopId: string): Promise<void> {
  const { data: conversa } = await supabase
    .from("conversations_chatbot")
    .select("id, historic")
    .eq("client_phone_number_id", clienteNumero)
    .eq("status", "em_andamento")
    .order("updated_at", { ascending: false })
    .limit(1)
    .single()

  if (conversa) {
    const historic = conversa.historic || []
    // REMOVE todos os estados antigos, mantém apenas o novo
    const outrosHistoricos = historic.filter((h: any) => h.tipo !== "estado_teste")
    const novoHistorico = [...outrosHistoricos, { role: "system", tipo: "estado_teste", content: estado }]

    const { error } = await supabase
      .from("conversations_chatbot")
      .update({ historic: novoHistorico, updated_at: new Date().toISOString() })
      .eq("id", conversa.id)
    if (error) console.error("[ERRO] salvarEstado update:", JSON.stringify(error))
  } else {
    const { error } = await supabase
      .from("conversations_chatbot")
      .insert({
        barbershop_id: barbershopId,
        barbershop_phone_number_id: phoneNumberId,
        client_phone_number_id: clienteNumero,
        historic: [{ role: "system", tipo: "estado_teste", content: estado }],
        status: "em_andamento",
      })
    if (error) console.error("[ERRO] salvarEstado insert:", JSON.stringify(error))
  }
}

// ============================================
// PROCESSAMENTO
// ============================================
async function processarComBotoes(
  texto: string,
  nomeCliente: string,
  estado: EstadoTeste,
  phoneNumberId: string,
  from: string,
  barbershopId: string
): Promise<string | null> {

  // CLIQUE NO BOTÃO AGENDAR
  if (texto === "acao_agendar") {
    estado.etapa = 'servico'
    estado.paginaServicos = 1
    await enviarMenuServicos(barbershopId, phoneNumberId, from, 1)
    return null
  }

  // CLIQUE NO BOTÃO MEUS AGENDAMENTOS
  if (texto === "acao_meus_agendamentos") {
    estado.etapa = 'listar_agendamentos'
    await enviarMenuServicos(barbershopId, phoneNumberId, from, estado.paginaServicos || 1)
    return null
  }

  //CLIQUE NO BOTÃO INFORMAÇÕES
  if (texto === "acao_informacoes") {
    estado.etapa = 'informacoes'
    await enviarMenuServicos(barbershopId, phoneNumberId, from, estado.paginaServicos || 1)
    return null
  }

  // NAVEGAÇÃO PAGINAÇÃO DE SERVIÇOS (página embutida no ID → funciona em mensagens antigas)
  const navMatch = texto.match(/^servico_pagina_(\d+)$/)
  if (navMatch) {
    const pagina = parseInt(navMatch[1])
    estado.paginaServicos = pagina
    await enviarMenuServicos(barbershopId, phoneNumberId, from, pagina)
    return null
  }

  // BOTÃO VOLTAR → volta ao menu inicial
  if (texto === "servico_voltar") {
    estado.etapa = 'inicio'
    await enviarBotoesIniciais(phoneNumberId, (await getBarbershopByPhone(phoneNumberId))?.name ?? "Barbearia", from, nomeCliente)
    return null
  }

  // BOTÃO MENU INICIAL → volta para etapa 1 sem cancelar nada
  if (texto === "servico_cancelar") {
    estado.etapa = 'inicio'
    await enviarBotoesIniciais(phoneNumberId, (await getBarbershopByPhone(phoneNumberId))?.name ?? "Barbearia", from, nomeCliente)
    return null
  }
  console.log("[CHAMOU processarComBotoes]", { texto, etapa: estado.etapa })
  // COMANDOS
  if (texto === "cancelar" || texto === "sair") {
    estado.etapa = 'inicio'
    estado.servico = undefined
    estado.dia = undefined
    estado.barbeiro = undefined
    estado.horario = undefined
    return "✅ Agendamento cancelado. Digite *AGENDAR* para começar!"
  }

  if (texto === "menu" || texto === "inicio") {
    estado.etapa = 'inicio'
    return "Digite *AGENDAR* para começar!"
  }

  // ============================================
  // DETECÇÃO DE CLIQUE EM MENSAGEM ANTIGA
  // Se o input pertence a uma etapa anterior, reseta o fluxo para ela
  // ============================================

  // Clicou em serviço antigo (UUID) estando em etapa posterior
  if (estado.etapa !== 'servico' && estado.etapa !== 'inicio') {
    const servicos = await getServicos(barbershopId)
    const servicoAntigo = servicos.find(s => s.id === texto)
    if (servicoAntigo) {
      estado.servico = servicoAntigo
      estado.dia = undefined
      estado.barbeiro = undefined
      estado.horario = undefined
      estado.etapa = 'dia'
      await enviarMenuDias(barbershopId, phoneNumberId, from)
      return null
    }
  }

  // Clicou em dia antigo (DD/MM) estando em etapa posterior (barbeiro, horario, confirmacao)
  if (['barbeiro', 'horario', 'confirmacao'].includes(estado.etapa) && texto.match(/^\d{2}\/\d{2}$/)) {
    const dias = await getDiasDisponiveis(barbershopId)
    const diaAntigo = dias.find(d => d.value === texto)
    if (diaAntigo) {
      estado.dia = diaAntigo.value
      estado.barbeiro = undefined
      estado.horario = undefined
      estado.etapa = 'barbeiro'
      estado.paginaBarbeiros = 1
      return enviarListaBarbeiros(1)
    }
  }

  // FLUXO
  switch (estado.etapa) {
    case 'inicio':
      if (texto.toLowerCase() === "agendar") {
        estado.etapa = 'servico'
        await enviarMenuServicos(barbershopId, phoneNumberId, from, estado.paginaServicos || 1)
        return null
      }
      await enviarBotoesIniciais(phoneNumberId, (await getBarbershopByPhone(phoneNumberId))?.name ?? "Barbearia", from, nomeCliente, "Pra gente seguir com teu agendamento é só clicar em uma das opções abaixo 😊")
      return null

    case 'servico': {
      const servicos = await getServicos(barbershopId)
      const servicoEncontrado = servicos.find(s =>
        s.id === texto ||
        s.name.toLowerCase() === texto.toLowerCase()
      )
      if (servicoEncontrado) {
        estado.servico = servicoEncontrado
        estado.etapa = 'dia'
        await enviarMenuDias(barbershopId, phoneNumberId, from)
        return null
      }
      return `❓ Digite o NÚMERO ou NOME do serviço. (${servicos.length} disponíveis)`
    }

    case 'dia': {
      const dias = await getDiasDisponiveis(barbershopId)
      const diaEncontrado = dias.find((d, i) =>
        String(i + 1) === texto ||
        d.value === texto
      )
      if (diaEncontrado) {
        estado.dia = diaEncontrado.value
        estado.etapa = 'barbeiro'
        estado.paginaBarbeiros = 1
        return enviarListaBarbeiros(estado.paginaBarbeiros)
      }
      return `❓ Digite o *NÚMERO* do dia. (${dias.length} disponíveis)`
    }

    case 'barbeiro':
      if (texto.toLowerCase() === "proximo") {
        const totalPaginas = Math.ceil(BARBEIROS_MOCK.length / 10)
        if (estado.paginaBarbeiros < totalPaginas) {
          estado.paginaBarbeiros++
          return enviarListaBarbeiros(estado.paginaBarbeiros)
        }
        return "📋 Última página. Digite o NÚMERO do barbeiro."
      }
      
      if (texto.toLowerCase() === "anterior") {
        if (estado.paginaBarbeiros > 1) {
          estado.paginaBarbeiros--
          return enviarListaBarbeiros(estado.paginaBarbeiros)
        }
        return "📋 Primeira página."
      }
      
      const barbeiro = BARBEIROS_MOCK.find(b => 
        b.id === texto || 
        b.name.toLowerCase().includes(texto.toLowerCase())
      )
      
      if (barbeiro) {
        estado.barbeiro = barbeiro
        estado.etapa = 'horario'
        return enviarMenuHorarios()
      }
      return "❓ Digite o NÚMERO ou NOME do barbeiro, ou PROXIMO para ver mais."

    case 'horario':
      const horarioMatch = texto.match(/(\d{1,2})[:h]?(\d{2})?/)
      if (horarioMatch) {
        const hora = horarioMatch[1].padStart(2, '0')
        const minuto = horarioMatch[2] || "00"
        estado.horario = `${hora}:${minuto}`
        estado.etapa = 'confirmacao'
        return mensagemConfirmacao(estado, nomeCliente)
      }
      return "❓ Digite um horário válido (ex: 14h, 14:30, 15)"

    case 'confirmacao':
      if (texto.toLowerCase() === "sim" || texto.toLowerCase() === "confirmar" || texto.toLowerCase() === "ok") {
        const msg = `✅ *AGENDADO!*\n\n` +
          `• Serviço: ${estado.servico?.name}\n` +
          `• Valor: R$ ${estado.servico?.price}\n` +
          `• Barbeiro: ${estado.barbeiro?.name} ⭐ ${estado.barbeiro?.rating}\n` +
          `• Data: ${estado.dia}\n` +
          `• Horário: ${estado.horario}\n\n` +
          `Te esperamos! 💈`
        
        estado.etapa = 'inicio'
        estado.servico = undefined
        estado.dia = undefined
        estado.barbeiro = undefined
        estado.horario = undefined
        
        return msg
      }
      
      if (texto.toLowerCase() === "nao" || texto.toLowerCase() === "cancelar") {
        estado.etapa = 'servico'
        estado.servico = undefined
        await enviarMenuServicos(barbershopId, phoneNumberId, from, estado.paginaServicos || 1)
        return null
      }
      
      return "❓ Confirme com *SIM* ou *NAO*"
  }

  return "Digite *AGENDAR* para começar!"
}

// ============================================
// MENSAGENS
// ============================================

async function enviarListaInterativa(
  phoneNumberId: string,
  to: string,
  header: string,
  body: string,
  buttonText: string,
  sectionTitle: string,
  rows: { id: string; title: string; description?: string }[]
): Promise<void> {
  const token = Deno.env.get("WHATSAPP_TOKEN")
  if (!token) return

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: header },
      body: { text: body },
      action: {
        button: buttonText,
        sections: [{ title: sectionTitle, rows }]
      }
    }
  }

  try {
    const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const result = await response.json()
    if (result.error) console.error("[ERRO] enviarListaInterativa:", JSON.stringify(result.error))
    else console.log("[LISTA] Enviada com sucesso")
  } catch (err) {
    console.error("[ERRO] enviarListaInterativa:", err)
  }
}

async function enviarMenuServicos(barbershopId: string, phoneNumberId: string, to: string, pagina = 1): Promise<void> {
  const servicos = await getServicos(barbershopId)
  if (servicos.length === 0) {
    await enviarWhatsApp(phoneNumberId, to, "⚠️ Nenhum serviço disponível no momento. Tente novamente em breve.")
    return
  }

  const temPaginacao = servicos.length > 10
  // Quando há paginação, reserva as últimas linhas para navegação
  const ITEMS_POR_PAGINA = temPaginacao ? 8 : 10
  const totalPaginas = Math.ceil(servicos.length / ITEMS_POR_PAGINA)
  const paginaValida = Math.min(Math.max(pagina, 1), totalPaginas)
  const inicio = (paginaValida - 1) * ITEMS_POR_PAGINA
  const servicosPagina = servicos.slice(inicio, inicio + ITEMS_POR_PAGINA)

  const temAnterior = paginaValida > 1
  const temProxima  = paginaValida < totalPaginas

  const rows: { id: string; title: string; description?: string }[] = servicosPagina.map(s => ({
    id: s.id,
    title: s.name.slice(0, 24),
    description: `R$ ${Number(s.price).toFixed(2).replace('.', ',')} • ${s.duration_min} min`
  }))

  // Navegação como últimas linhas — ID contém a página destino (evita erro ao clicar em mensagens antigas)
  if (temAnterior) rows.push({ id: `servico_pagina_${paginaValida - 1}`, title: "⬅️ Página anterior", description: `Ir para página ${paginaValida - 1}` })
  if (temProxima)  rows.push({ id: `servico_pagina_${paginaValida + 1}`, title: "Próxima página ➡️",  description: `Ir para página ${paginaValida + 1}` })

  const buttonText = temPaginacao
    ? `Ver serviços (${paginaValida}/${totalPaginas})`.slice(0, 20)
    : "Ver serviços"

  const bodyText = temPaginacao
    ? `Clique no botão para ver a lista ${paginaValida}/${totalPaginas} de serviços:`
    : "Clique no botão para ver os serviços:"

  await enviarListaInterativa(
    phoneNumberId, to,
    "✂️ Serviços",
    bodyText,
    buttonText,
    "Disponíveis",
    rows
  )
}

async function enviarMenuDias(barbershopId: string, phoneNumberId: string, to: string): Promise<void> {
  const dias = await getDiasDisponiveis(barbershopId)

  if (dias.length === 0) {
    await enviarWhatsApp(phoneNumberId, to, "😕 Nenhum dia disponível nos próximos 7 dias. Entre em contato com a barbearia.")
    return
  }

  const rows = dias.map(d => ({
    id: d.value,
    title: d.label.slice(0, 24),
  }))

  await enviarListaInterativa(
    phoneNumberId, to,
    "📅 Escolha o dia",
    "Toque no botão e escolha uma data:",
    "Ver datas",
    "Próximos 7 dias",
    rows
  )
}

function enviarListaBarbeiros(pagina: number): string {
  const itensPorPagina = 10
  const inicio = (pagina - 1) * itensPorPagina
  const barbeirosPagina = BARBEIROS_MOCK.slice(inicio, inicio + itensPorPagina)
  const totalPaginas = Math.ceil(BARBEIROS_MOCK.length / itensPorPagina)
  
  let msg = `👨‍🦱 *BARBEIROS (Pág ${pagina}/${totalPaginas})*\n\n`
  
  barbeirosPagina.forEach((b) => {
    msg += `• ${b.id} - ${b.name}\n  ${b.especialidade}\n\n`
  })
  
  if (totalPaginas > 1) {
    msg += `Digite PROXIMO ou ANTERIOR\n`
  }
  msg += `\nDigite o NÚMERO ou NOME do barbeiro.\n\n_Digite CANCELAR_`
  return msg
}

function enviarMenuHorarios(): string {
  return `⏰ *QUAL HORÁRIO?*\n\n` +
    `Funcionamento: 08:00 às 20:00\n\n` +
    `Digite o horário (ex: 14h, 14:30, 15)\n\n` +
    `_Digite CANCELAR_`
}

function mensagemConfirmacao(estado: EstadoTeste, nomeCliente: string): string {
  return `📋 *CONFIRMAR*\n\n` +
    `👤 ${nomeCliente}\n` +
    `✂️ ${estado.servico?.name} - R$ ${estado.servico?.price}\n` +
    `👨‍🦱 ${estado.barbeiro?.name} ⭐ ${estado.barbeiro?.rating}\n` +
    `📅 ${estado.dia} às ${estado.horario}\n\n` +
    `Digite *SIM* ou *NAO*`
}

// ============================================
// ENVIOS WHATSAPP
// ============================================

async function enviarBotoesIniciais(phoneNumberId: string, nomeBarbearia: string, to: string, nomeCliente: string, bodyText?: string): Promise<void> {
  const token = Deno.env.get("WHATSAPP_TOKEN")
  if (!token) return

  const mensagem = bodyText ?? `👋 Olá ${nomeCliente}! Bem-vindo à ${nomeBarbearia}!\n\nO que você gostaria de fazer?`

  const payload = {
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: mensagem },
      action: {
        buttons: [
          { type: "reply", reply: { id: "acao_agendar", title: "📅 AGENDAR" } },
          { type: "reply", reply: { id: "acao_meus_agendamentos", title: "📋 MEUS AGENDAMENTOS" } },
          { type: "reply", reply: { id: "acao_informacoes", title: "ℹ️ INFORMAÇÕES" } }
        ]
      }
    }
  }

  try {
    const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const result = await response.json()
    if (result.error) console.error("[ERRO] botão:", JSON.stringify(result.error))
    else console.log("[BOTÕES] Enviados com sucesso")
  } catch (err) {
    console.error("[ERRO] enviarBotoesIniciais:", err)
  }
}

async function enviarBotoesVoltar(phoneNumberId: string, to: string, bodyText = "."): Promise<void> {
  const token = Deno.env.get("WHATSAPP_TOKEN")
  if (!token) return

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: [
          { type: "reply", reply: { id: "servico_voltar", title: "⬅️ Voltar" } },
          { type: "reply", reply: { id: "servico_cancelar", title: "🏠 Menu inicial" } },
        ]
      }
    }
  }

  try {
    const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const result = await response.json()
    if (result.error) console.error("[ERRO] enviarBotoesVoltar:", JSON.stringify(result.error))
  } catch (err) {
    console.error("[ERRO] enviarBotoesVoltar:", err)
  }
}

async function enviarBotoesData(phoneNumberId: string, to: string, nomeCliente: string): Promise<void> {
  const token = Deno.env.get("WHATSAPP_TOKEN")
  if (!token) return

  const payload = {
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: `📅 Qual dia você quer agendar?` },
      action: {
        buttons: [
          { type: "reply", reply: { id: "dia_hoje", title: "📅 Hoje" } },
          { type: "reply", reply: { id: "dia_amanha", title: "📋 Amanhã" } },
          { type: "reply", reply: { id: "dia_outra", title: "🗓️ Outra data" } }
        ]
      }
    }
  }

  try {
    const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const result = await response.json()
    if (result.error) console.error("[ERRO] botão:", JSON.stringify(result.error))
    else console.log("[BOTÕES] Enviados com sucesso")
  } catch (err) {
    console.error("[ERRO] enviarBotoesIniciais:", err)
  }
}

async function enviarWhatsApp(phoneNumberId: string, to: string, texto: string): Promise<void> {
  const token = Deno.env.get("WHATSAPP_TOKEN")
  if (!token) return

  try {
    const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: texto },
      }),
    })
    const result = await response.json()
    if (result.error) console.error("[ERRO] enviarWhatsApp:", JSON.stringify(result.error))
  } catch (err) {
    console.error("[ERRO] enviarWhatsApp:", err)
  }
}