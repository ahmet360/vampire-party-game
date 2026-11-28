const MODEL_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent";

function createGeminiBot(key, request = fetch) {
  if (typeof key !== "string" || !/^[A-Za-z0-9._-]{16,256}$/.test(key)) return null;
  const lifetime = new AbortController();
  let unavailableUntil = 0;

  return {
    get available() { return !lifetime.signal.aborted && Date.now() >= unavailableUntil; },
    close() { lifetime.abort(); },

    async decide(context) {
      if (!this.available) return null;
      try {
        const response = await request(MODEL_URL, {
          method: "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          redirect: "error",
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(6500)]),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: "You are a player in a Vampire social deduction game. Choose a voteTarget from the eligible player aliases and write one short line of conversation. Address replyTo when present. If challenged, ask for the player's reason. Never invent evidence or claim a hidden role. Use the supplied aliases when referring to players. Return an empty voteTarget if nobody is eligible." }] },
            contents: [{ role: "user", parts: [{ text: JSON.stringify(context) }] }],
            generationConfig: {
              thinkingConfig: { thinkingLevel: "LOW" },
              maxOutputTokens: 1024,
              responseMimeType: "application/json",
              responseJsonSchema: {
                type: "object",
                properties: { voteTarget: { type: "string" }, line: { type: "string" } },
                required: ["voteTarget", "line"],
              },
            },
          }),
        });
        if (!response.ok) {
          unavailableUntil = Date.now() + 60000;
          return null;
        }
        const result = await response.json();
        const text = result.candidates?.[0]?.content?.parts?.filter((part) => !part.thought).map((part) => part.text || "").join("");
        const choice = JSON.parse(text || "null");
        if (lifetime.signal.aborted || typeof choice?.line !== "string" || typeof choice.voteTarget !== "string") return null;
        return { voteTarget: choice.voteTarget, line: choice.line.trim().replace(/\s+/g, " ").slice(0, 240) };
      } catch {
        if (!lifetime.signal.aborted) unavailableUntil = Date.now() + 60000;
        return null;
      }
    },
  };
}

module.exports = { createGeminiBot };
