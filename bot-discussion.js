const SUSPICION = /\b(?:suspects?|suspicious|vampire|accus\w*|vote[sd]?|voting|guilty)\b/i;
const TRUST = /\b(?:trust|vouch|innocent|clear|safe)\b/i;

function mentionsPlayer(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

function scoreSeed(text) {
  let score = 0;
  for (const character of text) score = (Math.imul(31, score) + character.codePointAt(0)) >>> 0;
  return score;
}

function formOpinion(bot, candidates, discussion) {
  const messages = discussion.filter((entry) => !entry.automated).slice(-16);
  const people = candidates.map((player) => {
    let score = (scoreSeed(`${bot.id}:${player.id}`) % 11) / 11;
    const views = new Map();
    for (const message of messages) {
      if (message.playerId === player.id || !mentionsPlayer(message.text, player.name)) continue;
      if (TRUST.test(message.text)) views.set(message.playerId, -1);
      else if (SUSPICION.test(message.text)) views.set(message.playerId, 1);
    }
    const suspicion = [...views.values()].reduce((sum, view) => sum + view, 0);
    score += suspicion;
    // This is a revealed role from the public roster, never the underlying role.
    if (player.publicRole === "Vampire" && !bot.onVampireTeam) score += 10;
    if (bot.preferredTargets.includes(player.id)) score += 12;
    return { player, score, suspicion };
  });
  people.sort((first, second) => second.score - first.score);
  return people[0] ?? null;
}

function writeDiscussionLine(bot, opinion, dayNumber, reply) {
  const name = opinion?.player.name;
  const variant = scoreSeed(`${bot.id}:${dayNumber}:${reply?.id ?? "opening"}`) % 3;
  if (reply && mentionsPlayer(reply.text, bot.name) && SUSPICION.test(reply.text)) {
    return `${reply.name}, what made you suspect me? ${name ? `I’m leaning toward ${name}, but I’d like to hear your reason.` : "Let’s compare what we actually know."}`;
  }
  const address = reply ? `${reply.name}, ` : "";
  if (!name) return `${address}I’d like to hear what everyone thinks before voting.`;
  if (opinion.player.publicRole === "Vampire" && !bot.onVampireTeam) {
    return `${address}I’m voting for ${name}. The public reveal showed they’re a Vampire.`;
  }
  if (opinion.suspicion > 0) {
    return `${address}${[
      `I’m leaning toward ${name}. They’ve come up in the discussion. What’s the strongest reason to vote for them?`,
      `I’d put pressure on ${name}. I want to hear their side before I commit.`,
      `My vote is leaning toward ${name} right now. I’d change it if someone has a better lead.`,
    ][variant]}`;
  }
  return `${address}${[
    `I don’t have a strong read yet. ${name}, who would you vote for?`,
    `I’d start by hearing from ${name}. I’m keeping an open mind before the vote.`,
    `My first guess is ${name}, but it’s a weak one. What has everyone else picked up?`,
  ][variant]}`;
}

module.exports = { formOpinion, mentionsPlayer, writeDiscussionLine };
