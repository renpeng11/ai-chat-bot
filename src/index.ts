export interface Env {
  DB: D1Database;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  FEISHU_VERIFICATION_TOKEN?: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_TARGET_RECEIVE_ID?: string;
  FEISHU_TARGET_RECEIVE_ID_TYPE?: string;
  FEISHU_BOT_WEBHOOK?: string;
  ZHIPU_API_KEY?: string;
  ZHIPU_MODEL?: string;
  AUTO_REPLY_ENABLED?: string;
  TZ?: string;
  SEARCH_API_KEY?: string;
  SEARCH_API_ENDPOINT?: string;
}

type FeishuInbound = {
  messageId?: string;
  chatId?: string;
  senderId?: string;
  senderName?: string;
  messageType: string;
  content: string;
};

type SearchResult = {
  title: string;
  link: string;
  snippet: string;
  source?: string;
};

type SummaryRecord = {
  id: number;
  summary_date: string;
  content: string;
  source_message_count: number;
  prompt: string;
  raw_response: string | null;
  sent_status: string;
  sent_error: string | null;
  sent_at: string | null;
  created_at: string;
};

type AiModel = {
  id: number;
  name: string;
  provider: string;
  base_url: string;
  api_key: string;
  model: string;
  is_active: number;
  created_at: string;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
};

const SESSION_COOKIE = "fd_session";

async function getActiveModel(env: Env): Promise<AiModel | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, provider, base_url, api_key, model, is_active, created_at
     FROM ai_models
     WHERE is_active = 1
     LIMIT 1`,
  ).first<AiModel>();
  return row ?? null;
}

async function callAI(
  env: Env,
  modelConfig: { base_url: string; api_key: string; model: string },
  messages: Array<{ role: string; content: string }>,
  temperature = 0.3,
): Promise<{ content: string; raw: string }> {
  const url = modelConfig.base_url.replace(/\/+$/, "") + "/chat/completions";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      authorization: `Bearer ${modelConfig.api_key}`,
    },
    body: JSON.stringify({
      model: modelConfig.model,
      messages,
      temperature,
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`AI API HTTP ${response.status}: ${raw}`);
  }

  const data = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("AI response did not include content");
  }
  return { content, raw };
}

async function getModelConfig(
  env: Env,
): Promise<{ base_url: string; api_key: string; model: string }> {
  const activeModel = await getActiveModel(env);
  if (activeModel) {
    return {
      base_url: activeModel.base_url,
      api_key: activeModel.api_key,
      model: activeModel.model,
    };
  }
  if (env.ZHIPU_API_KEY) {
    return {
      base_url: "https://open.bigmodel.cn/api/paas/v4",
      api_key: env.ZHIPU_API_KEY,
      model: env.ZHIPU_MODEL ?? "glm-4-flash",
    };
  }
  throw new Error(
    "未配置 AI 模型，请在「AI 模型配置」中添加并激活一个模型，或在环境变量中设置 ZHIPU_API_KEY",
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/") {
        return redirect("/admin");
      }

      if (url.pathname === "/health") {
        return json({ ok: true });
      }

      if (url.pathname === "/feishu/webhook" && request.method === "POST") {
        return handleFeishuWebhook(request, env, ctx);
      }

      if (url.pathname === "/admin" && request.method === "GET") {
        if (!env.ADMIN_PASSWORD) {
          return new Response(
            renderLoginPage(
              "ADMIN_PASSWORD 环境变量未配置，请在 Cloudflare Workers 中设置该变量",
            ),
            {
              status: 401,
              headers: HTML_HEADERS,
            },
          );
        }
        if (!(await isAdminSession(request, env))) {
          return new Response(renderLoginPage(), { headers: HTML_HEADERS });
        }
        return new Response(renderAdminPage(), {
          headers: {
            ...HTML_HEADERS,
            "cache-control": "no-store",
          },
        });
      }

      if (url.pathname === "/login" && request.method === "POST") {
        return handleLogin(request, env);
      }

      if (url.pathname === "/logout" && request.method === "POST") {
        return redirectWithCookie("/admin", clearSessionCookie());
      }

      if (url.pathname.startsWith("/api/")) {
        if (!(await isAdminSession(request, env)))
          return json({ error: "Unauthorized" }, 401);
        return handleApi(request, env, url);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: errorMessage(error) }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await createAndSendDailySummary(env, {
      refreshExisting: true,
      sendEvenIfSent: true,
    });
  },
};

async function handleFeishuWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const payload = await request.json<unknown>();
  const body = payload as Record<string, unknown>;

  if (body.type === "url_verification" && typeof body.challenge === "string") {
    validateFeishuToken(body, env);
    return json({ challenge: body.challenge });
  }

  validateFeishuToken(body, env);

  const inbound = extractFeishuMessage(body);
  if (!inbound.content.trim()) {
    return json({ ok: true, skipped: "empty_or_unsupported_message" });
  }

  await env.DB.prepare(
    `INSERT INTO inbound_messages
      (message_id, chat_id, sender_id, sender_name, message_type, content, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      inbound.messageId ?? null,
      inbound.chatId ?? null,
      inbound.senderId ?? null,
      inbound.senderName ?? null,
      inbound.messageType,
      inbound.content,
      JSON.stringify(body),
    )
    .run();

  if (shouldAutoReply(env, inbound)) {
    ctx.waitUntil(autoReplyToInboundMessage(env, inbound));
  }

  return json({ ok: true });
}

async function handleApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (url.pathname === "/api/messages" && request.method === "GET") {
    const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 300);
    const rows = await env.DB.prepare(
      `SELECT id, message_id, chat_id, sender_id, sender_name, message_type, content, received_at
       FROM inbound_messages
       ORDER BY received_at DESC
       LIMIT ?`,
    )
      .bind(limit)
      .all();
    return json({ messages: rows.results });
  }

  if (url.pathname === "/api/summaries" && request.method === "GET") {
    const limit = clamp(Number(url.searchParams.get("limit") ?? 60), 1, 200);
    const rows = await env.DB.prepare(
      `SELECT id, summary_date, content, source_message_count, sent_status, sent_error, sent_at, created_at
       FROM summaries
       ORDER BY created_at DESC
       LIMIT ?`,
    )
      .bind(limit)
      .all();
    return json({ summaries: rows.results });
  }

  if (url.pathname === "/api/summaries/run" && request.method === "POST") {
    const activeModel = await getActiveModel(env);
    if (!activeModel && !env.ZHIPU_API_KEY) {
      return json(
        {
          error:
            "未配置 AI 模型，请在「AI 模型配置」中添加并激活一个模型，或在环境变量中设置 ZHIPU_API_KEY",
        },
        500,
      );
    }
    const summary = await createAndSendDailySummary(env, {
      refreshExisting: true,
      sendEvenIfSent: true,
    });
    return json({ summary });
  }

  const resendMatch = url.pathname.match(/^\/api\/summaries\/(\d+)\/send$/);
  if (resendMatch && request.method === "POST") {
    const summary = await getSummary(env, Number(resendMatch[1]));
    if (!summary) return json({ error: "Summary not found" }, 404);
    const result = await sendSummaryToFeishu(env, summary);
    return json({ result });
  }

  if (url.pathname === "/api/outgoing" && request.method === "GET") {
    const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 300);
    const rows = await env.DB.prepare(
      `SELECT id, summary_id, channel, content, status, error, sent_at, created_at
       FROM outgoing_messages
       ORDER BY created_at DESC
       LIMIT ?`,
    )
      .bind(limit)
      .all();
    return json({ outgoing: rows.results });
  }

  if (url.pathname === "/api/outgoing" && request.method === "POST") {
    const body = await request.json<{ content?: string }>();
    const content = (body.content ?? "").trim();
    if (!content) return json({ error: "content is required" }, 400);
    const result = await sendFeishuText(env, content);
    await recordOutgoing(
      env,
      null,
      content,
      result.ok ? "sent" : "failed",
      result.error,
    );
    return json({ result });
  }

  if (url.pathname === "/api/search/test" && request.method === "POST") {
    const body = await request.json<{ query?: string }>();
    const query = (body.query ?? "").trim();
    if (!query) return json({ error: "query is required" }, 400);

    const hasKeywords = hasSearchKeywords(query);

    const { needSearch, query: suggestedQuery } = await shouldSearchWithAI(
      env,
      query,
    );
    const searchResult = needSearch
      ? await webSearchWithDebug(env, suggestedQuery || query)
      : { results: [], error: null, response: null };

    return json({
      query,
      hasKeywords,
      needSearch,
      suggestedQuery,
      searchResults: searchResult.results,
      searchEnabled: !!env.SEARCH_API_KEY,
      searchError: searchResult.error,
      searchResponse: searchResult.response
        ? JSON.stringify(searchResult.response).slice(0, 1000)
        : null,
    });
  }

  if (url.pathname === "/api/models" && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT id, name, provider, base_url, api_key, model, is_active, created_at
       FROM ai_models
       ORDER BY created_at DESC`,
    ).all();
    return json({ models: rows.results });
  }

  if (url.pathname === "/api/models" && request.method === "POST") {
    const body = await request.json<{
      name?: string;
      provider?: string;
      base_url?: string;
      api_key?: string;
      model?: string;
    }>();
    const name = (body.name ?? "").trim();
    const base_url = (body.base_url ?? "").trim();
    const api_key = (body.api_key ?? "").trim();
    const model = (body.model ?? "").trim();
    if (!name || !base_url || !api_key || !model) {
      return json({ error: "name, base_url, api_key, model 都是必填项" }, 400);
    }

    const insert = await env.DB.prepare(
      `INSERT INTO ai_models (name, provider, base_url, api_key, model, is_active)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
      .bind(
        name,
        body.provider ?? "openai_compatible",
        base_url,
        api_key,
        model,
      )
      .run();

    const id = Number(insert.meta.last_row_id);
    const created = await env.DB.prepare(
      `SELECT id, name, provider, base_url, api_key, model, is_active, created_at
       FROM ai_models WHERE id = ?`,
    )
      .bind(id)
      .first<AiModel>();
    return json({ model: created }, 201);
  }

  const modelUpdateMatch = url.pathname.match(/^\/api\/models\/(\d+)$/);
  if (modelUpdateMatch && request.method === "PUT") {
    const body = await request.json<{
      name?: string;
      provider?: string;
      base_url?: string;
      api_key?: string;
      model?: string;
    }>();
    const existing = await env.DB.prepare(
      `SELECT id FROM ai_models WHERE id = ?`,
    )
      .bind(Number(modelUpdateMatch[1]))
      .first();
    if (!existing) return json({ error: "Model not found" }, 404);

    await env.DB.prepare(
      `UPDATE ai_models
       SET name = COALESCE(?, name),
           provider = COALESCE(?, provider),
           base_url = COALESCE(?, base_url),
           api_key = COALESCE(?, api_key),
           model = COALESCE(?, model)
       WHERE id = ?`,
    )
      .bind(
        body.name?.trim() ?? null,
        body.provider ?? null,
        body.base_url?.trim() ?? null,
        body.api_key?.trim() ?? null,
        body.model?.trim() ?? null,
        Number(modelUpdateMatch[1]),
      )
      .run();

    const updated = await env.DB.prepare(
      `SELECT id, name, provider, base_url, api_key, model, is_active, created_at
       FROM ai_models WHERE id = ?`,
    )
      .bind(Number(modelUpdateMatch[1]))
      .first<AiModel>();
    return json({ model: updated });
  }

  if (modelUpdateMatch && request.method === "DELETE") {
    const existing = await env.DB.prepare(
      `SELECT id FROM ai_models WHERE id = ?`,
    )
      .bind(Number(modelUpdateMatch[1]))
      .first();
    if (!existing) return json({ error: "Model not found" }, 404);

    await env.DB.prepare(`DELETE FROM ai_models WHERE id = ?`)
      .bind(Number(modelUpdateMatch[1]))
      .run();
    return json({ ok: true });
  }

  const modelActivateMatch = url.pathname.match(
    /^\/api\/models\/(\d+)\/activate$/,
  );
  if (modelActivateMatch && request.method === "POST") {
    const targetId = Number(modelActivateMatch[1]);
    const existing = await env.DB.prepare(
      `SELECT id FROM ai_models WHERE id = ?`,
    )
      .bind(targetId)
      .first();
    if (!existing) return json({ error: "Model not found" }, 404);

    await env.DB.prepare(`UPDATE ai_models SET is_active = 0`).run();
    await env.DB.prepare(`UPDATE ai_models SET is_active = 1 WHERE id = ?`)
      .bind(targetId)
      .run();

    const activated = await env.DB.prepare(
      `SELECT id, name, provider, base_url, api_key, model, is_active, created_at
       FROM ai_models WHERE id = ?`,
    )
      .bind(targetId)
      .first<AiModel>();
    return json({ model: activated });
  }

  return json({ error: "Not found" }, 404);
}

async function createAndSendDailySummary(
  env: Env,
  options: { refreshExisting?: boolean; sendEvenIfSent?: boolean } = {},
): Promise<SummaryRecord> {
  const summaryDate = formatDateInTimeZone(
    new Date(),
    env.TZ ?? "Asia/Shanghai",
  );
  const existing = await env.DB.prepare(
    `SELECT id, summary_date, content, source_message_count, prompt, raw_response, sent_status, sent_error, sent_at, created_at
     FROM summaries
     WHERE summary_date = ?`,
  )
    .bind(summaryDate)
    .first<SummaryRecord>();

  const summary =
    existing && options.refreshExisting
      ? await updateSummary(env, existing.id, summaryDate)
      : (existing ?? (await createSummary(env, summaryDate)));
  if (options.sendEvenIfSent || summary.sent_status !== "sent") {
    await sendSummaryToFeishu(env, summary);
    return (await getSummary(env, summary.id)) ?? summary;
  }
  return summary;
}

async function createSummary(
  env: Env,
  summaryDate: string,
): Promise<SummaryRecord> {
  const summary = await buildSummary(env, summaryDate);

  const insert = await env.DB.prepare(
    `INSERT INTO summaries (summary_date, content, source_message_count, prompt, raw_response)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      summaryDate,
      summary.content,
      summary.sourceMessageCount,
      summary.prompt,
      summary.raw,
    )
    .run();

  const id = Number(insert.meta.last_row_id);
  const created = await getSummary(env, id);
  if (!created) throw new Error("Summary was created but could not be loaded");
  return created;
}

async function updateSummary(
  env: Env,
  id: number,
  summaryDate: string,
): Promise<SummaryRecord> {
  const summary = await buildSummary(env, summaryDate);
  await env.DB.prepare(
    `UPDATE summaries
     SET content = ?, source_message_count = ?, prompt = ?, raw_response = ?, sent_status = 'pending',
         sent_error = NULL, sent_at = NULL
     WHERE id = ?`,
  )
    .bind(
      summary.content,
      summary.sourceMessageCount,
      summary.prompt,
      summary.raw,
      id,
    )
    .run();

  const updated = await getSummary(env, id);
  if (!updated) throw new Error("Summary was updated but could not be loaded");
  return updated;
}

async function buildSummary(
  env: Env,
  summaryDate: string,
): Promise<{
  content: string;
  sourceMessageCount: number;
  prompt: string;
  raw: string;
}> {
  const range = getShanghaiDayRange(summaryDate);
  const messages = await env.DB.prepare(
    `SELECT sender_name, sender_id, content, received_at
     FROM inbound_messages
     WHERE received_at >= ? AND received_at < ?
     ORDER BY received_at ASC`,
  )
    .bind(range.startUtc, range.endUtc)
    .all<{
      sender_name: string | null;
      sender_id: string | null;
      content: string;
      received_at: string;
    }>();

  const prompt = buildSummaryPrompt(summaryDate, messages.results);
  const ai = await summarizeWithZhipu(env, prompt);
  return {
    content: ai.content,
    sourceMessageCount: messages.results.length,
    prompt,
    raw: ai.raw,
  };
}

async function sendSummaryToFeishu(
  env: Env,
  summary: SummaryRecord,
): Promise<{ ok: boolean; error?: string }> {
  const text = `每日消息总结 ${summary.summary_date}\n\n${summary.content}`;
  const result = await sendFeishuText(env, text);
  await env.DB.prepare(
    `UPDATE summaries
     SET sent_status = ?, sent_error = ?, sent_at = ?
     WHERE id = ?`,
  )
    .bind(
      result.ok ? "sent" : "failed",
      result.error ?? null,
      result.ok ? new Date().toISOString() : null,
      summary.id,
    )
    .run();
  await recordOutgoing(
    env,
    summary.id,
    text,
    result.ok ? "sent" : "failed",
    result.error,
  );
  return result;
}

async function sendFeishuText(
  env: Env,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  if (
    env.FEISHU_APP_ID &&
    env.FEISHU_APP_SECRET &&
    env.FEISHU_TARGET_RECEIVE_ID
  ) {
    return sendFeishuAppText(
      env,
      text,
      env.FEISHU_TARGET_RECEIVE_ID,
      env.FEISHU_TARGET_RECEIVE_ID_TYPE || "chat_id",
    );
  }

  if (!env.FEISHU_BOT_WEBHOOK) {
    return {
      ok: false,
      error:
        "Configure FEISHU_APP_ID, FEISHU_APP_SECRET and FEISHU_TARGET_RECEIVE_ID, or configure FEISHU_BOT_WEBHOOK",
    };
  }

  const response = await fetch(env.FEISHU_BOT_WEBHOOK, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      msg_type: "text",
      content: { text },
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      error: `Feishu webhook HTTP ${response.status}: ${responseText}`,
    };
  }

  try {
    const data = JSON.parse(responseText) as {
      code?: number;
      StatusCode?: number;
      msg?: string;
      StatusMessage?: string;
    };
    const code = data.code ?? data.StatusCode ?? 0;
    if (code !== 0) {
      return {
        ok: false,
        error: data.msg ?? data.StatusMessage ?? responseText,
      };
    }
  } catch {
    // Some webhook variants return an empty body on success.
  }

  return { ok: true };
}

async function sendFeishuAppText(
  env: Env,
  text: string,
  receiveId: string,
  receiveIdType = "chat_id",
): Promise<{ ok: boolean; error?: string }> {
  const token = await getFeishuTenantAccessToken(env);
  const response = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
    {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    },
  );

  const responseText = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      error: `Feishu message HTTP ${response.status}: ${responseText}`,
    };
  }

  const data = JSON.parse(responseText) as { code?: number; msg?: string };
  if ((data.code ?? 0) !== 0) {
    return { ok: false, error: data.msg ?? responseText };
  }
  return { ok: true };
}

async function autoReplyToInboundMessage(
  env: Env,
  inbound: FeishuInbound,
): Promise<void> {
  if (!inbound.chatId) return;

  try {
    const reply = await generateAutoReplyWithSearch(env, inbound);
    const result = await sendFeishuAppText(
      env,
      reply,
      inbound.chatId,
      "chat_id",
    );
    await recordOutgoing(
      env,
      null,
      reply,
      result.ok ? "sent" : "failed",
      result.error,
    );
  } catch (error) {
    const errorText = errorMessage(error);
    await recordOutgoing(
      env,
      null,
      `自动回复失败：${inbound.content}`,
      "failed",
      errorText,
    );
    console.error("auto reply failed", error);
  }
}

async function generateAutoReply(
  env: Env,
  inbound: FeishuInbound,
): Promise<string> {
  const config = await getModelConfig(env);
  const result = await callAI(
    env,
    config,
    [
      {
        role: "system",
        content:
          "你是飞书里的个人 AI 助手。请直接回复用户消息，中文为主，简洁、友好、可执行。不要声称你无法读取上下文之外的信息。",
      },
      {
        role: "user",
        content: [
          `发送者：${inbound.senderName || inbound.senderId || "未知"}`,
          `消息类型：${inbound.messageType}`,
          "消息内容：",
          inbound.content,
        ].join("\n"),
      },
    ],
    0.6,
  );
  return result.content;
}

async function getFeishuTenantAccessToken(env: Env): Promise<string> {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required");
  }

  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        app_id: env.FEISHU_APP_ID,
        app_secret: env.FEISHU_APP_SECRET,
      }),
    },
  );

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Feishu token HTTP ${response.status}: ${responseText}`);
  }

  const data = JSON.parse(responseText) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
  };
  if ((data.code ?? 0) !== 0 || !data.tenant_access_token) {
    throw new Error(
      data.msg ?? "Feishu token response did not include tenant_access_token",
    );
  }
  return data.tenant_access_token;
}

async function recordOutgoing(
  env: Env,
  summaryId: number | null,
  content: string,
  status: "sent" | "failed",
  error?: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO outgoing_messages (summary_id, content, status, error, sent_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      summaryId,
      content,
      status,
      error ?? null,
      status === "sent" ? new Date().toISOString() : null,
    )
    .run();
}

async function summarizeWithZhipu(
  env: Env,
  prompt: string,
): Promise<{ content: string; raw: string }> {
  const config = await getModelConfig(env);
  return callAI(
    env,
    config,
    [
      {
        role: "system",
        content:
          "你是一个可靠的个人消息助理。请用简洁中文总结事实、待办和风险，不编造不存在的信息。",
      },
      { role: "user", content: prompt },
    ],
    0.3,
  );
}

async function getSummary(env: Env, id: number): Promise<SummaryRecord | null> {
  return env.DB.prepare(
    `SELECT id, summary_date, content, source_message_count, prompt, raw_response, sent_status, sent_error, sent_at, created_at
     FROM summaries
     WHERE id = ?`,
  )
    .bind(id)
    .first<SummaryRecord>();
}

function buildSummaryPrompt(
  summaryDate: string,
  messages: Array<{
    sender_name: string | null;
    sender_id: string | null;
    content: string;
    received_at: string;
  }>,
): string {
  if (messages.length === 0) {
    return `日期：${summaryDate}\n今天没有收到可总结的飞书消息。请输出一句简短总结。`;
  }

  const transcript = messages
    .map((message, index) => {
      const sender = message.sender_name || message.sender_id || "未知发送者";
      return `${index + 1}. [${message.received_at}] ${sender}: ${message.content}`;
    })
    .join("\n");

  return [
    `日期：${summaryDate}`,
    "请总结下面的飞书消息，输出：",
    "1. 今日要点",
    "2. 待办事项",
    "3. 需要关注的风险或阻塞",
    "4. 一句话结论",
    "",
    transcript,
  ].join("\n");
}

function extractFeishuMessage(body: Record<string, unknown>): FeishuInbound {
  const event = asRecord(body.event) ?? body;
  const message = asRecord(event.message) ?? event;
  const sender = asRecord(event.sender);
  const senderId = asRecord(sender?.sender_id);

  const rawContent = message.content;
  const messageType =
    stringValue(message.message_type) ??
    stringValue(message.msg_type) ??
    "text";
  const content = parseFeishuContent(rawContent, messageType);

  return {
    messageId:
      stringValue(message.message_id) ?? stringValue(message.open_message_id),
    chatId: stringValue(message.chat_id) ?? stringValue(event.open_chat_id),
    senderId:
      stringValue(senderId?.user_id) ??
      stringValue(senderId?.open_id) ??
      stringValue(event.open_id),
    senderName: stringValue(sender?.sender_type),
    messageType,
    content,
  };
}

function parseFeishuContent(rawContent: unknown, messageType: string): string {
  if (typeof rawContent === "string") {
    try {
      const parsed = JSON.parse(rawContent) as Record<string, unknown>;
      return contentFromParsedFeishuContent(parsed, messageType);
    } catch {
      return rawContent;
    }
  }
  if (asRecord(rawContent)) {
    return contentFromParsedFeishuContent(
      rawContent as Record<string, unknown>,
      messageType,
    );
  }
  return "";
}

function contentFromParsedFeishuContent(
  content: Record<string, unknown>,
  messageType: string,
): string {
  if (typeof content.text === "string") return content.text;
  if (typeof content.title === "string") return content.title;
  if (messageType !== "text")
    return `[${messageType}] ${JSON.stringify(content)}`;
  return JSON.stringify(content);
}

function validateFeishuToken(body: Record<string, unknown>, env: Env): void {
  if (!env.FEISHU_VERIFICATION_TOKEN) return;
  const token =
    stringValue(body.token) ?? stringValue(asRecord(body.header)?.token);
  if (token !== env.FEISHU_VERIFICATION_TOKEN) {
    throw new Error("Invalid Feishu verification token");
  }
}

function shouldAutoReply(env: Env, inbound: FeishuInbound): boolean {
  if ((env.AUTO_REPLY_ENABLED ?? "true").toLowerCase() === "false")
    return false;
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) return false;
  if (!inbound.chatId) return false;
  if (!inbound.content.trim()) return false;
  return true;
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");

  if (!env.ADMIN_PASSWORD) {
    return new Response(
      renderLoginPage(
        "ADMIN_PASSWORD 环境变量未配置，请在 Cloudflare Workers 中设置该变量",
      ),
      {
        status: 401,
        headers: HTML_HEADERS,
      },
    );
  }

  if (
    username !== (env.ADMIN_USERNAME || "admin") ||
    password !== env.ADMIN_PASSWORD
  ) {
    return new Response(renderLoginPage("账号或密码不正确"), {
      status: 401,
      headers: HTML_HEADERS,
    });
  }

  return redirectWithCookie("/admin", await createSessionCookie(env));
}

async function isAdminSession(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = getCookie(request, SESSION_COOKIE);
  if (!cookie) return false;

  const [expiresText, signature] = cookie.split(".");
  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || !signature || Date.now() > expires)
    return false;

  const expected = await signSession(env, expiresText);
  return timingSafeEqual(signature, expected);
}

async function createSessionCookie(env: Env): Promise<string> {
  const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const signature = await signSession(env, String(expires));
  return `${SESSION_COOKIE}=${expires}.${signature}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

async function signSession(env: Env, value: string): Promise<string> {
  const secret = `${env.ADMIN_PASSWORD}:${env.FEISHU_APP_SECRET ?? ""}:${env.ZHIPU_API_KEY ?? ""}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return base64Url(signature);
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  const cookies = header.split(";").map((part) => part.trim());
  const prefix = `${name}=`;
  const match = cookies.find((part) => part.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : undefined;
}

function base64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function renderLoginPage(error = ""): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登录 - 飞书消息总结管理</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #20242c;
      --muted: #697386;
      --line: #dde3ea;
      --accent: #1f7a68;
      --accent-strong: #155c50;
      --danger: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 18px;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(420px, 100%);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 22px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 20px;
    }
    p {
      margin: 0 0 18px;
      color: var(--muted);
    }
    label {
      display: grid;
      gap: 6px;
      margin: 12px 0;
      font-weight: 650;
    }
    input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 11px 12px;
      font: inherit;
    }
    button {
      width: 100%;
      border: 0;
      border-radius: 6px;
      padding: 11px 12px;
      margin-top: 8px;
      background: var(--accent);
      color: white;
      cursor: pointer;
      font-weight: 700;
      font: inherit;
    }
    button:hover { background: var(--accent-strong); }
    .error {
      margin: 0 0 12px;
      color: var(--danger);
      font-weight: 700;
    }
  </style>
</head>
<body>
  <main>
    <h1>飞书消息总结管理</h1>
    <p>登录后查看消息、总结和推送记录。</p>
    ${error ? `<div class="error">${escapeHtmlText(error)}</div>` : ""}
    <form method="post" action="/login">
      <label>
        用户名
        <input name="username" autocomplete="username" value="admin" required>
      </label>
      <label>
        密码
        <input name="password" type="password" autocomplete="current-password" required>
      </label>
      <button type="submit">登录</button>
    </form>
  </main>
</body>
</html>`;
}

function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>飞书消息总结管理</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #20242c;
      --muted: #697386;
      --line: #dde3ea;
      --accent: #1f7a68;
      --accent-strong: #155c50;
      --danger: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 24px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    h1 { margin: 0; font-size: 20px; }
    main {
      display: grid;
      gap: 18px;
      padding: 20px 24px 32px;
      max-width: 1400px;
      margin: 0 auto;
    }
    .toolbar, section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .toolbar {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
      padding: 14px;
    }
    .toolbar > * {
      flex: 0 0 auto;
    }
    section { overflow: hidden; }
    section h2 {
      margin: 0;
      padding: 14px 16px;
      font-size: 16px;
      border-bottom: 1px solid var(--line);
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 18px;
    }
    button {
      border: 0;
      border-radius: 6px;
      padding: 9px 12px;
      background: var(--accent);
      color: white;
      cursor: pointer;
      font-weight: 650;
    }
    button:hover { background: var(--accent-strong); }
    button.secondary {
      background: #eef4f2;
      color: var(--accent-strong);
      border: 1px solid #c8ddd8;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    form.logout {
      margin: 0;
    }
    form.logout button {
      background: #eef4f2;
      color: var(--accent-strong);
      border: 1px solid #c8ddd8;
    }
    textarea {
      width: min(520px, 100%);
      min-height: 72px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px;
      font: inherit;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      background: #fbfcfd;
    }
    td.content {
      white-space: pre-wrap;
      word-break: break-word;
      min-width: 240px;
    }
    .status-failed { color: var(--danger); font-weight: 700; }
    .status-sent { color: var(--accent-strong); font-weight: 700; }
    .muted { color: var(--muted); }
    #notice { min-height: 20px; color: var(--muted); }
    @media (max-width: 900px) {
      header { align-items: flex-start; flex-direction: column; }
      .header-actions {
        width: 100%;
        justify-content: space-between;
      }
      main { padding: 14px; }
      .grid { grid-template-columns: 1fr; }
      .toolbar { align-items: stretch; }
      .toolbar > *, textarea {
        width: 100%;
        flex: 1 1 100%;
      }
      section {
        border-radius: 6px;
      }
      table, thead, tbody, tr, th, td {
        display: block;
      }
      thead {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
      tbody {
        display: grid;
        gap: 10px;
        padding: 10px;
      }
      tr {
        border: 1px solid var(--line);
        border-radius: 6px;
        background: #fff;
        overflow: hidden;
      }
      td {
        display: grid;
        grid-template-columns: 92px minmax(0, 1fr);
        gap: 10px;
        padding: 9px 10px;
        border-bottom: 1px solid #edf1f5;
      }
      td:last-child { border-bottom: 0; }
      td::before {
        content: attr(data-label);
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }
      td.content {
        min-width: 0;
      }
      td button {
        width: 100%;
      }
    }
    @media (max-width: 520px) {
      header { padding: 14px; }
      h1 { font-size: 18px; }
      main { padding: 10px; gap: 12px; }
      .toolbar { padding: 10px; }
      section h2 { padding: 12px; }
      td {
        grid-template-columns: 76px minmax(0, 1fr);
        font-size: 13px;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>飞书消息总结管理</h1>
    <div class="header-actions">
      <div id="notice"></div>
      <form class="logout" method="post" action="/logout">
        <button type="submit">退出登录</button>
      </form>
    </div>
  </header>
  <main>
    <div class="toolbar">
      <button id="refreshBtn" class="secondary">刷新</button>
      <button id="runBtn">立即生成并推送今日总结</button>
      <textarea id="customMessage" placeholder="输入一条要推送到飞书的消息"></textarea>
      <button id="sendCustomBtn">发送消息</button>
    </div>
    <div class="grid">
      <section>
        <h2>收到的消息</h2>
        <table>
          <thead><tr><th>时间</th><th>会话 ID</th><th>发送者 ID</th><th>发送者</th><th>内容</th></tr></thead>
          <tbody id="messages"></tbody>
        </table>
      </section>
      <section>
        <h2>总结内容</h2>
        <table>
          <thead><tr><th>日期</th><th>条数</th><th>状态</th><th>内容</th><th>操作</th></tr></thead>
          <tbody id="summaries"></tbody>
        </table>
      </section>
    </div>
    <section>
      <h2>发出的消息</h2>
      <table>
        <thead><tr><th>时间</th><th>状态</th><th>内容</th><th>错误</th></tr></thead>
        <tbody id="outgoing"></tbody>
      </table>
    </section>
    <section>
      <h2>AI 模型配置</h2>
      <div style="padding:14px 16px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
          <button id="addModelBtn" class="secondary">+ 添加模型</button>
          <span id="modelNotice" style="color:var(--muted);font-size:13px;align-self:center;"></span>
        </div>
        <div id="modelForm" style="display:none;border:1px solid var(--line);border-radius:6px;padding:14px;margin-bottom:14px;background:#fbfcfd;">
          <div style="display:grid;gap:10px;grid-template-columns:1fr 1fr;">
            <label style="display:grid;gap:4px;font-weight:650;font-size:13px;">
              名称
              <input id="modelName" placeholder="例如：智谱 GLM" style="border:1px solid var(--line);border-radius:6px;padding:9px 10px;font:inherit;">
            </label>
            <label style="display:grid;gap:4px;font-weight:650;font-size:13px;">
              API 地址
              <input id="modelBaseUrl" placeholder="https://open.bigmodel.cn/api/paas/v4" style="border:1px solid var(--line);border-radius:6px;padding:9px 10px;font:inherit;">
            </label>
            <label style="display:grid;gap:4px;font-weight:650;font-size:13px;">
              API Key
              <input id="modelApiKey" placeholder="sk-..." type="password" style="border:1px solid var(--line);border-radius:6px;padding:9px 10px;font:inherit;">
            </label>
            <label style="display:grid;gap:4px;font-weight:650;font-size:13px;">
              模型 ID
              <input id="modelId" placeholder="glm-4-flash" style="border:1px solid var(--line);border-radius:6px;padding:9px 10px;font:inherit;">
            </label>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px;">
            <button id="saveModelBtn" style="border:0;border-radius:6px;padding:9px 12px;background:var(--accent);color:white;cursor:pointer;font-weight:650;">保存</button>
            <button id="cancelModelBtn" class="secondary" style="background:#eef4f2;color:var(--accent-strong);border:1px solid #c8ddd8;border-radius:6px;padding:9px 12px;cursor:pointer;font-weight:650;">取消</button>
          </div>
        </div>
        <table>
          <thead><tr><th>名称</th><th>API 地址</th><th>模型 ID</th><th>状态</th><th>操作</th></tr></thead>
          <tbody id="models"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const notice = document.getElementById('notice');
    const setNotice = (text) => { notice.textContent = text; };
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
    const formatTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';

    async function api(path, options) {
      const response = await fetch(path, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options && options.headers) },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.statusText);
      return data;
    }

    async function refresh() {
      setNotice('加载中...');
      const [messages, summaries, outgoing, models] = await Promise.all([
        api('/api/messages'),
        api('/api/summaries'),
        api('/api/outgoing'),
        api('/api/models')
      ]);
      document.getElementById('messages').innerHTML = messages.messages.map((row) => \`
        <tr>
          <td data-label="时间">\${escapeHtml(formatTime(row.received_at))}</td>
          <td data-label="会话 ID" class="content">\${escapeHtml(row.chat_id || '-')}</td>
          <td data-label="发送者 ID" class="content">\${escapeHtml(row.sender_id || '-')}</td>
          <td data-label="发送者">\${escapeHtml(row.sender_name || row.sender_id || '-')}</td>
          <td data-label="内容" class="content">\${escapeHtml(row.content)}</td>
        </tr>\`).join('') || '<tr><td colspan="5" class="muted">暂无消息</td></tr>';

      document.getElementById('summaries').innerHTML = summaries.summaries.map((row) => \`
        <tr>
          <td data-label="日期">\${escapeHtml(row.summary_date)}</td>
          <td data-label="条数">\${escapeHtml(row.source_message_count)}</td>
          <td data-label="状态" class="status-\${escapeHtml(row.sent_status)}">\${escapeHtml(row.sent_status)}</td>
          <td data-label="内容" class="content">\${escapeHtml(row.content)}</td>
          <td data-label="操作"><button class="secondary" data-resend="\${row.id}">重发</button></td>
        </tr>\`).join('') || '<tr><td colspan="5" class="muted">暂无总结</td></tr>';

      document.getElementById('outgoing').innerHTML = outgoing.outgoing.map((row) => \`
        <tr>
          <td data-label="时间">\${escapeHtml(formatTime(row.created_at))}</td>
          <td data-label="状态" class="status-\${escapeHtml(row.status)}">\${escapeHtml(row.status)}</td>
          <td data-label="内容" class="content">\${escapeHtml(row.content)}</td>
          <td data-label="错误" class="content">\${escapeHtml(row.error || '')}</td>
        </tr>\`).join('') || '<tr><td colspan="4" class="muted">暂无发出记录</td></tr>';

      document.getElementById('models').innerHTML = models.models.length
        ? models.models.map((row) => \`
            <tr>
              <td data-label="名称">\${escapeHtml(row.name)}</td>
              <td data-label="API 地址" class="content" style="font-size:12px;">\${escapeHtml(row.base_url)}</td>
              <td data-label="模型 ID">\${escapeHtml(row.model)}</td>
              <td data-label="状态">\${row.is_active
                ? '<span style="color:var(--accent-strong);font-weight:700;">活跃</span>'
                : '<span class="muted">未激活</span>'}</td>
              <td data-label="操作" style="white-space:nowrap;">
                \${row.is_active ? '' : '<button class="secondary" data-activate="' + row.id + '" style="margin-right:4px;">激活</button>'}
                <button class="secondary" data-edit-model='\${escapeHtml(JSON.stringify(row))}'>编辑</button>
                <button class="secondary" data-delete="\${row.id}" style="color:var(--danger);">删除</button>
              </td>
            </tr>\`).join('')
        : '<tr><td colspan="5" class="muted">暂无模型配置，点击「+ 添加模型」添加</td></tr>';

      document.querySelectorAll('[data-resend]').forEach((button) => {
        button.addEventListener('click', async () => {
          setNotice('正在重发...');
          await api('/api/summaries/' + button.dataset.resend + '/send', { method: 'POST' });
          await refresh();
        });
      });

      document.querySelectorAll('[data-activate]').forEach((button) => {
        button.addEventListener('click', async () => {
          setNotice('正在激活...');
          await api('/api/models/' + button.dataset.activate + '/activate', { method: 'POST' });
          setNotice('已切换活跃模型');
          await refresh();
        });
      });

      document.querySelectorAll('[data-edit-model]').forEach((button) => {
        button.addEventListener('click', () => {
          const model = JSON.parse(button.dataset.editModel);
          document.getElementById('modelName').value = model.name;
          document.getElementById('modelBaseUrl').value = model.base_url;
          document.getElementById('modelApiKey').value = model.api_key;
          document.getElementById('modelId').value = model.model;
          document.getElementById('saveModelBtn').dataset.editId = model.id;
          document.getElementById('modelForm').style.display = 'block';
          document.getElementById('modelNotice').textContent = '';
        });
      });

      document.querySelectorAll('[data-delete]').forEach((button) => {
        button.addEventListener('click', async () => {
          if (!confirm('确定要删除这个模型配置吗？')) return;
          setNotice('正在删除...');
          await api('/api/models/' + button.dataset.delete, { method: 'DELETE' });
          setNotice('已删除');
          await refresh();
        });
      });

      setNotice('已刷新 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    }

    document.getElementById('refreshBtn').addEventListener('click', refresh);
    document.getElementById('runBtn').addEventListener('click', async () => {
      setNotice('正在生成总结...');
      await api('/api/summaries/run', { method: 'POST' });
      await refresh();
    });
    document.getElementById('sendCustomBtn').addEventListener('click', async () => {
      const textarea = document.getElementById('customMessage');
      const content = textarea.value.trim();
      if (!content) return setNotice('请输入要发送的消息');
      setNotice('正在发送...');
      await api('/api/outgoing', { method: 'POST', body: JSON.stringify({ content }) });
      textarea.value = '';
      await refresh();
    });

    document.getElementById('addModelBtn').addEventListener('click', () => {
      document.getElementById('modelName').value = '';
      document.getElementById('modelBaseUrl').value = '';
      document.getElementById('modelApiKey').value = '';
      document.getElementById('modelId').value = '';
      delete document.getElementById('saveModelBtn').dataset.editId;
      document.getElementById('modelForm').style.display = 'block';
      document.getElementById('modelNotice').textContent = '';
    });

    document.getElementById('cancelModelBtn').addEventListener('click', () => {
      document.getElementById('modelForm').style.display = 'none';
      document.getElementById('modelNotice').textContent = '';
    });

    document.getElementById('saveModelBtn').addEventListener('click', async () => {
      const name = document.getElementById('modelName').value.trim();
      const base_url = document.getElementById('modelBaseUrl').value.trim();
      const api_key = document.getElementById('modelApiKey').value.trim();
      const model = document.getElementById('modelId').value.trim();
      if (!name || !base_url || !api_key || !model) {
        return document.getElementById('modelNotice').textContent = '请填写所有字段';
      }
      const editId = document.getElementById('saveModelBtn').dataset.editId;
      setNotice('正在保存...');
      if (editId) {
        await api('/api/models/' + editId, {
          method: 'PUT',
          body: JSON.stringify({ name, base_url, api_key, model }),
        });
      } else {
        await api('/api/models', {
          method: 'POST',
          body: JSON.stringify({ name, base_url, api_key, model }),
        });
      }
      document.getElementById('modelForm').style.display = 'none';
      setNotice('已保存');
      await refresh();
    });

    refresh().catch((error) => setNotice(error.message));
  </script>
</body>
</html>`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

function redirect(path: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: path },
  });
}

function redirectWithCookie(path: string, cookie: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: path,
      "set-cookie": cookie,
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

function getShanghaiDayRange(summaryDate: string): {
  startUtc: string;
  endUtc: string;
} {
  const start = new Date(`${summaryDate}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc: start.toISOString(), endUtc: end.toISOString() };
}

async function webSearch(env: Env, query: string): Promise<SearchResult[]> {
  if (!env.SEARCH_API_KEY) {
    return [];
  }

  const endpoint = env.SEARCH_API_ENDPOINT || "https://serpapi.com/search";
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", env.SEARCH_API_KEY);
  url.searchParams.set("engine", "google");
  url.searchParams.set("num", "5");
  url.searchParams.set("hl", "zh-CN");

  try {
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      console.error(`Search API HTTP ${response.status}`);
      return [];
    }

    const data = (await response.json()) as Record<string, unknown>;
    const results =
      (data.organic_results as Array<Record<string, unknown>>) ||
      (data.results as Array<Record<string, unknown>>) ||
      [];

    return results
      .map((result) => ({
        title: String(result.title || ""),
        link: String(result.link || ""),
        snippet: String(result.snippet || ""),
        source: String(result.source || ""),
      }))
      .filter((r) => r.title && r.link);
  } catch (error) {
    console.error("Search failed:", error);
    return [];
  }
}

async function webSearchWithDebug(
  env: Env,
  query: string,
): Promise<{
  results: SearchResult[];
  error: string | null;
  response: Record<string, unknown> | null;
}> {
  if (!env.SEARCH_API_KEY) {
    return {
      results: [],
      error: "SEARCH_API_KEY not configured",
      response: null,
    };
  }

  const endpoint = env.SEARCH_API_ENDPOINT || "https://serpapi.com/search";
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", env.SEARCH_API_KEY);
  url.searchParams.set("engine", "google");
  url.searchParams.set("num", "5");
  url.searchParams.set("hl", "zh-CN");

  try {
    const response = await fetch(url.toString(), { method: "GET" });
    const responseText = await response.text();

    console.log(
      `Search URL: ${url.toString().replace(env.SEARCH_API_KEY, "[REDACTED]")}`,
    );
    console.log(`Search HTTP status: ${response.status}`);
    console.log(`Search response: ${responseText.slice(0, 500)}`);

    if (!response.ok) {
      const errorMsg = `Search API HTTP ${response.status}: ${responseText.slice(0, 200)}`;
      console.error(errorMsg);
      return { results: [], error: errorMsg, response: null };
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(responseText);
    } catch {
      return {
        results: [],
        error: "Failed to parse response as JSON",
        response: null,
      };
    }

    const results =
      (data.organic_results as Array<Record<string, unknown>>) ||
      (data.results as Array<Record<string, unknown>>) ||
      [];
    console.log(`Search returned ${results.length} results`);

    return {
      results: results
        .map((result) => ({
          title: String(result.title || ""),
          link: String(result.link || ""),
          snippet: String(result.snippet || ""),
          source: String(result.source || ""),
        }))
        .filter((r) => r.title && r.link),
      error: null,
      response: data,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Search failed:", errorMsg);
    return { results: [], error: errorMsg, response: null };
  }
}

function hasSearchKeywords(content: string): boolean {
  const searchKeywords = [
    "最新",
    "今天",
    "现在",
    "最近",
    "今日",
    "当前",
    "新闻",
    "动态",
    "行情",
    "价格",
    "天气",
    "股票",
    "汇率",
    "发布",
    "上市",
    "更新",
    "公告",
    "政策",
    "通知",
    "多少",
    "什么是",
    "怎么样",
    "如何",
    "哪里",
    "何时",
    "新闻",
    "热搜",
    "热点",
    "事件",
    "消息",
  ];

  const text = content.toLowerCase();
  return searchKeywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

async function shouldSearchWithAI(
  env: Env,
  content: string,
): Promise<{ needSearch: boolean; query?: string }> {
  let config: { base_url: string; api_key: string; model: string };
  try {
    config = await getModelConfig(env);
  } catch {
    return { needSearch: false };
  }

  const hasKeywords = hasSearchKeywords(content);

  try {
    const result = await callAI(
      env,
      config,
      [
        {
          role: "system",
          content:
            "你是一个智能搜索决策助手。请分析用户的问题，判断是否需要进行联网搜索来获取最新信息。\n" +
            "需要搜索的情况包括但不限于：\n" +
            "- 需要最新新闻、事件、数据\n" +
            "- 需要当前的价格、行情、天气\n" +
            "- 需要了解最近发生的事情\n" +
            "- 需要查找特定的事实或数据\n" +
            "- 包含时间词（如今天、现在、最近、今日、当前）的问题\n" +
            "- 询问新闻、动态、行情、价格等信息\n" +
            "不需要搜索的情况包括：\n" +
            "- 日常对话、闲聊（如你好、谢谢、再见）\n" +
            "- 已有知识可以回答的问题（如什么是人工智能、历史知识）\n" +
            "- 不需要最新信息的问题\n" +
            '\n请输出 JSON 格式：{"needSearch": true/false, "query": "搜索关键词（如果需要搜索）"}',
        },
        {
          role: "user",
          content: content,
        },
      ],
      0.1,
    );

    try {
      const parsed = JSON.parse(result.content) as {
        needSearch?: boolean;
        query?: string;
      };
      const needSearch = parsed.needSearch === true || hasKeywords;
      return {
        needSearch,
        query: parsed.query || content,
      };
    } catch {
      console.error("Failed to parse search decision response");
    }
  } catch (error) {
    console.error("Search decision failed:", error);
  }

  return { needSearch: hasKeywords, query: content };
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "";

  return `\n\n【联网搜索结果】\n${results
    .map(
      (result, index) =>
        `${index + 1}. ${result.title}\n   ${result.snippet}\n   来源: ${result.link}`,
    )
    .join("\n\n")}`;
}

async function generateAutoReplyWithSearch(
  env: Env,
  inbound: FeishuInbound,
): Promise<string> {
  let searchResults = "";

  if (env.SEARCH_API_KEY) {
    const { needSearch, query } = await shouldSearchWithAI(
      env,
      inbound.content,
    );
    if (needSearch) {
      const results = await webSearch(env, query || inbound.content);
      searchResults = formatSearchResults(results);
    }
  }

  const config = await getModelConfig(env);
  const result = await callAI(
    env,
    config,
    [
      {
        role: "system",
        content:
          "你是飞书里的个人 AI 助手。请直接回复用户消息，中文为主，简洁、友好、可执行。\n" +
          "如果提供了联网搜索结果，请优先参考搜索结果进行回答，并在回答中注明信息来源。\n" +
          "不要声称你无法读取上下文之外的信息。",
      },
      {
        role: "user",
        content: [
          `发送者：${inbound.senderName || inbound.senderId || "未知"}`,
          `消息类型：${inbound.messageType}`,
          "消息内容：",
          inbound.content,
          searchResults,
        ].join("\n"),
      },
    ],
    0.6,
  );
  return result.content;
}
