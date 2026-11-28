const SUSPICION = /\b(?:suspects?|suspicious|vampire|accus\w*|vote[sd]?|voting|guilty)\b/i;
const TRUST = /\b(?:trust|vouch|innocent|clear|safe)\b/i;

function mentionsPlayer(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

function prepareBotDiscussion({ bot, roster, candidates, messages, day, reply }) {
  const aliases = new Map(roster.map((player, index) => [player.id, `P${index + 1}`]));
  const names = new Map(roster.map(({ id, name }) => [aliases.get(id), name]));
  const eligible = new Map(candidates.map(({ id }) => [aliases.get(id), id]));
  const recent = messages.filter((entry) => !entry.automated && entry.dayNumber === day).slice(-10);
  const context = {
    day,
    speaker: aliases.get(bot.id),
    replyTo: aliases.get(reply?.playerId),
    challenged: Boolean(reply && mentionsPlayer(reply.text, bot.name) && SUSPICION.test(reply.text)),
    eligible: candidates.map((player) => {
      const notes = new Map();
      for (const message of recent) {
        if (message.playerId === player.id || !mentionsPlayer(message.text, player.name)) continue;
        if (TRUST.test(message.text)) notes.set(message.playerId, -1);
        else if (SUSPICION.test(message.text)) notes.set(message.playerId, 1);
      }
      return {
        player: aliases.get(player.id), publicRole: player.publicRole || (player.mayorRevealed ? "Mayor" : null),
        suspicion: [...notes.values()].reduce((sum, score) => sum + score, 0),
      };
    }),
  };
  return {
    context,
    readDecision(decision) {
      const targetId = eligible.get(decision.voteTarget);
      const text = decision.line.replace(/\bP\d+\b/g, (alias) => names.get(alias) || "another player");
      return { targetId, text: text.slice(0, 240) };
    },
  };
}

module.exports = { mentionsPlayer, prepareBotDiscussion };
