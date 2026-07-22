const { SlashCommandBuilder } = require('discord.js');
const { t } = require('../utils/i18n');
const { logger } = require('../utils/logger');
const ServerSettings = require('../database/models/ServerSettings');
const { resolveEndpointConfig } = require('../utils/informationssystemConfig');
const { queryInformationssystem, formatCitations, splitDiscordMessage } = require('../utils/informationssystemService');

const FRAGE_COOLDOWN_MS = Number(process.env.FRAGE_COOLDOWN_MS) || 10000;

const EPHEMERAL = 64;
const SUPPRESS_EMBEDS = 4;

const MAX_MESSAGE_PARTS = 4;
const MAX_COOLDOWN_ENTRIES = 5000;

const SAFE_MENTIONS = { parse: [] };

const activeRequests = new Set();
const cooldowns = new Map();

const ERROR_MESSAGE_KEYS = {
  IS_TIMEOUT: 'frage.timeout',
  IS_UNREACHABLE: 'frage.unreachable',
  IS_SERVICE_UNAVAILABLE: 'frage.serviceUnavailable',
  IS_VALIDATION_ERROR: 'frage.invalidResponse',
  IS_HTTP_ERROR: 'frage.invalidResponse',
  IS_INVALID_JSON: 'frage.invalidResponse',
  IS_INVALID_RESPONSE: 'frage.invalidResponse'
};

function pruneCooldowns() {
  const now = Date.now();
  for (const [id, timestamp] of cooldowns) {
    if (now - timestamp >= FRAGE_COOLDOWN_MS) cooldowns.delete(id);
  }
}

async function sendInteractionText(interaction, content, { ephemeral = false } = {}) {
  const payload = {
    content,
    allowedMentions: SAFE_MENTIONS,
    ...(ephemeral ? { flags: EPHEMERAL } : {})
  };

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (err) {
    logger.error('frage: failed to deliver reply to Discord', { error: err.message });
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('frage')
    .setDescription('Ask the information system a question (other topics are not answered).')
    .addStringOption(option =>
      option
        .setName('frage')
        .setDescription('Your question about the information system - unrelated questions are not answered.')
        .setRequired(true)
        .setMaxLength(2000)
    ),

  async execute(interaction) {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const question = interaction.options.getString('frage').trim();

    if (cooldowns.size > MAX_COOLDOWN_ENTRIES) pruneCooldowns();

    if (!question) {
      return sendInteractionText(interaction, await t(guildId, 'frage.emptyQuestion'), { ephemeral: true });
    }

    let endpoint;
    try {
      const settings = await ServerSettings.findOne({ guildId }).lean();
      endpoint = resolveEndpointConfig(settings);
    } catch (err) {
      logger.error('frage: failed to load endpoint config, using default', { guildId, error: err.message });
      endpoint = resolveEndpointConfig(null);
    }

    if (!endpoint.enabled) {
      return sendInteractionText(interaction, await t(guildId, 'frage.disabled'), { ephemeral: true });
    }

    if (activeRequests.has(userId)) {
      return sendInteractionText(interaction, await t(guildId, 'frage.alreadyRunning'), { ephemeral: true });
    }

    const lastRequestAt = cooldowns.get(userId);
    if (lastRequestAt) {
      const elapsed = Date.now() - lastRequestAt;
      if (elapsed < FRAGE_COOLDOWN_MS) {
        const seconds = Math.ceil((FRAGE_COOLDOWN_MS - elapsed) / 1000);
        return sendInteractionText(interaction, await t(guildId, 'frage.cooldown', { seconds }), { ephemeral: true });
      }
    }

    activeRequests.add(userId);

    try {
      await interaction.deferReply();

      const result = await queryInformationssystem(question, endpoint);

      if (result.refused || !result.answer) {
        await interaction.editReply({
          content: await t(guildId, 'frage.refused'),
          allowedMentions: SAFE_MENTIONS
        });
        return;
      }

      const fullText = result.citations.length
        ? `${result.answer}\n\n${await t(guildId, 'frage.sourcesLabel')}\n${formatCitations(result.citations)}`
        : result.answer;

      const allParts = splitDiscordMessage(fullText, 1900);
      const truncated = allParts.length > MAX_MESSAGE_PARTS;
      const parts = truncated ? allParts.slice(0, MAX_MESSAGE_PARTS) : allParts;

      await interaction.editReply({
        content: parts[0],
        allowedMentions: SAFE_MENTIONS,
        flags: SUPPRESS_EMBEDS
      });

      for (const part of parts.slice(1)) {
        await interaction.followUp({
          content: part,
          allowedMentions: SAFE_MENTIONS,
          flags: SUPPRESS_EMBEDS
        });
      }

      if (truncated) {
        await interaction.followUp({
          content: await t(guildId, 'frage.truncated'),
          allowedMentions: SAFE_MENTIONS
        });
      }
    } catch (err) {
      logger.error('frage: query failed', { userId, guildId, code: err.code, error: err.message });
      const key = ERROR_MESSAGE_KEYS[err.code] || 'frage.unexpectedError';
      await sendInteractionText(interaction, await t(guildId, key));
    } finally {
      activeRequests.delete(userId);
      cooldowns.set(userId, Date.now());
    }
  }
};
