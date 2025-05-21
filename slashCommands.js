// slashCommands.js
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('helpmint')
    .setDescription('Show the Mint Bot help menu'),

  new SlashCommandBuilder()
    .setName('trackmint')
    .setDescription('Start tracking a contract')
    .addStringOption(opt => opt.setName('name').setDescription('Name for this contract').setRequired(true))
    .addStringOption(opt => opt.setName('address').setDescription('Contract address').setRequired(true))
    .addNumberOption(opt => opt.setName('price').setDescription('Mint price (number)').setRequired(true))
    .addStringOption(opt => opt.setName('token').setDescription('Token used to mint').setRequired(false)),

  new SlashCommandBuilder()
    .setName('untrackmint')
    .setDescription('Stop tracking a contract')
    .addStringOption(opt => opt.setName('name').setDescription('Contract name to stop').setRequired(true)),

  new SlashCommandBuilder()
    .setName('channels')
    .setDescription('Show all alert channels for a contract')
    .addStringOption(opt => opt.setName('name').setDescription('Contract name').setRequired(true)),
 
  new SlashCommandBuilder()
  .setName('flex')
  .setDescription('Flex a random minted NFT from a contract tracked in this channel'),


  new SlashCommandBuilder()
    .setName('untrackchannel')
    .setDescription('Remove this channel from a contract’s alerts')
    .addStringOption(opt => opt.setName('name').setDescription('Contract name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('mintest')
    .setDescription('Simulate a mint for test/debugging')
]
.map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log('🌐 Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered globally!');
  } catch (err) {
    console.error('❌ Error registering slash commands:', err);
  }
})();
