require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField,
  REST, Routes, SlashCommandBuilder
} = require('discord.js');
const { JsonRpcProvider, Contract, ZeroAddress, id, Interface, ethers } = require('ethers');
const fetch = require('node-fetch');
const fs = require('fs');
const { Client: PgClient } = require('pg');


// === TOKEN SETUP ===
const TOKEN_NAME_TO_ADDRESS = {
  'ADRIAN': '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea'
};
const FALLBACK_PRICES = {
  '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea': 0.0000000268056
};

// === WALLET SHORT LINK ===
function shortWalletLink(address) {
  const short = address.slice(0, 6) + '...' + address.slice(-4);
  return `[${short}](https://opensea.io/${address})`;
}

// === DB SETUP ===
const pg = new PgClient({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
pg.connect();

pg.query(`CREATE TABLE IF NOT EXISTS contract_watchlist (
  name TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  mint_price NUMERIC NOT NULL,
  mint_token TEXT DEFAULT 'ETH',
  mint_token_symbol TEXT DEFAULT 'ETH',
  channel_ids TEXT[]
)`);
pg.query(`ALTER TABLE contract_watchlist ADD COLUMN IF NOT EXISTS mint_token_symbol TEXT DEFAULT 'ETH';`);

// === DISCORD CLIENT ===
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// === RPC SETUP ===
const rpcUrls = [
  'https://mainnet.base.org',
  'https://developer-access-mainnet.base.org',
  'https://base.blockpi.network/v1/rpc/public'
];
let provider;
(async () => {
  for (const url of rpcUrls) {
    try {
      const temp = new JsonRpcProvider(url);
      await temp.getBlockNumber();
      provider = temp;
      console.log(`✅ Connected to RPC: ${url}`);
      break;
    } catch {
      console.warn(`⚠️ Failed RPC: ${url}`);
    }
  }
  if (!provider) throw new Error('❌ All RPCs failed');
})();

// === SLASH COMMANDS ===
const commands = [
  new SlashCommandBuilder()
    .setName('trackmint')
    .setDescription('Track a new minting contract')
    .addStringOption(opt => opt.setName('name').setDescription('Contract name').setRequired(true))
    .addStringOption(opt => opt.setName('address').setDescription('Contract address').setRequired(true))
    .addNumberOption(opt => opt.setName('price').setDescription('Mint price per NFT').setRequired(true))
    .addStringOption(opt => opt.setName('token').setDescription('Token symbol or address').setRequired(false)),

  new SlashCommandBuilder()
    .setName('untrackmint')
    .setDescription('Stop tracking a contract')
    .addStringOption(opt => opt.setName('name').setDescription('Contract name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('channels')
    .setDescription('View all alert channels for a contract')
    .addStringOption(opt => opt.setName('name').setDescription('Contract name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('untrackchannel')
    .setDescription('Remove current channel from a contract\'s alerts')
    .addStringOption(opt => opt.setName('name').setDescription('Contract name').setRequired(true)),

  new SlashCommandBuilder()
    .setName('mintest')
    .setDescription('Simulate a mint test'),

  new SlashCommandBuilder()
    .setName('selltest')
    .setDescription('Simulate a sale alert'),

  new SlashCommandBuilder()
    .setName('helpmint')
    .setDescription('Show help for minting commands')
];

// === REGISTER SLASH ===
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
(async () => {
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered.');
  } catch (e) {
    console.error('❌ Error registering slash commands:', e);
  }
})();
// === JSON HELPERS ===
function loadJson(path) {
  try { return JSON.parse(fs.readFileSync(path)); } catch { return null; }
}
function saveJson(path, data) {
  fs.writeFileSync(path, JSON.stringify(data));
}
function blockPath(name) { return `./lastBlock_${name}.json`; }
function seenPath(name) { return `./seen_${name}.json`; }
function seenSalesPath(name) { return `./sales_${name}.json`; }

// === ETH VALUE HELPERS ===
async function getEthPriceFromToken(tokenInput) {
  let addr = tokenInput.toLowerCase();
  if (TOKEN_NAME_TO_ADDRESS[tokenInput.toUpperCase()]) {
    addr = TOKEN_NAME_TO_ADDRESS[tokenInput.toUpperCase()].toLowerCase();
  }
  if (!addr || addr === 'eth') return 1;

  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${addr}&vs_currencies=eth`);
    const data = await res.json();
    const price = data?.[addr]?.eth;
    if (!isNaN(price) && price > 0) return price;
  } catch {}

  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${addr}`);
    const data = await res.json();
    const priceStr = data?.data?.attributes?.token_prices?.eth;
    const price = priceStr ? parseFloat(priceStr) : null;
    if (!isNaN(price) && price > 0) return price;
  } catch {}

  return FALLBACK_PRICES[addr] || null;
}

async function getRealDexPriceForToken(tokenAmount, tokenAddress) {
  const routerAddress = '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86';
  const abi = ['function getAmountsIn(uint amountOut, address[] path) view returns (uint[] memory)'];
  const router = new Contract(routerAddress, abi, provider);
  const WETH = '0x4200000000000000000000000000000000000006';

  try {
    const path = [WETH, tokenAddress.toLowerCase()];
    const parsedOut = ethers.parseUnits(tokenAmount.toString(), 18);
    const result = await router.getAmountsIn(parsedOut, path);
    const ethNeeded = ethers.formatUnits(result[0], 18);
    return parseFloat(ethNeeded);
  } catch (err) {
    console.warn(`⚠️ getAmountsIn failed: ${err.message}`);
    return null;
  }
}

// === MULTI-GUILD SAFE SENDER ===
async function sendToUniqueGuilds(channel_ids, embed, row = null) {
  const sentChannels = new Set();
  console.log(`📢 Sending embed to channels:`, channel_ids);

  for (const id of channel_ids) {
    if (sentChannels.has(id)) continue;

    try {
      const ch = await client.channels.fetch(id);
      if (!ch || !ch.send) {
        console.warn(`❌ Channel ${id} not found or not text-capable.`);
        continue;
      }

      await ch.send({ embeds: [embed], components: row ? [row] : [] });
      console.log(`✅ Sent to channel ${id} (${ch.name}) in guild ${ch.guild?.name || 'Unknown'}`);
      sentChannels.add(id);
    } catch (err) {
      console.warn(`❌ Failed to send to channel ${id}: ${err.message}`);
    }
  }
}
// === CONTRACT TRACKING (MINTS + SALES) ===
async function trackContract({ name, address, mint_price, mint_token, mint_token_symbol, channel_ids }) {
  const abi = [
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ];
  const iface = new Interface(abi);
  const contract = new Contract(address, abi, provider);

  let seenTokenIds = new Set(loadJson(seenPath(name)) || []);
  let seenSales = new Set(loadJson(seenSalesPath(name)) || []);

  provider.on('block', async (blockNumber) => {
    const fromBlock = Math.max(blockNumber - 1, 0);

    let logs;
    try {
      logs = await provider.getLogs({
        fromBlock,
        toBlock: blockNumber,
        address,
        topics: [id('Transfer(address,address,uint256)')]
      });
    } catch {
      return;
    }

    const newMints = [];
    const newSales = [];

    for (const log of logs) {
      let parsed;
      try {
        parsed = iface.parseLog(log);
      } catch {
        continue;
      }

      const { from, to, tokenId } = parsed.args;
      const tokenIdStr = tokenId.toString();

      if (from === ZeroAddress) {
        if (seenTokenIds.has(tokenIdStr)) continue;
        seenTokenIds.add(tokenIdStr);

        let imageUrl = 'https://via.placeholder.com/400x400.png?text=NFT';
        try {
          let uri = await contract.tokenURI(tokenId);
          if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
          const meta = await fetch(uri, { timeout: 3000 }).then(res => res.json());
          if (meta?.image) {
            imageUrl = meta.image.startsWith('ipfs://')
              ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
              : meta.image;
          }
        } catch {}

        newMints.push({ tokenId, imageUrl, to, tokenAmount: mint_price });
      } else {
        if (seenSales.has(tokenIdStr)) continue;
        seenSales.add(tokenIdStr);

        newSales.push({ tokenId, from, to, transactionHash: log.transactionHash });
      }
    }

    // === MINT EMBED ===
    if (newMints.length) {
      const total = newMints.reduce((sum, m) => sum + Number(m.tokenAmount), 0);

      let tokenAddr = mint_token.toLowerCase();
      if (TOKEN_NAME_TO_ADDRESS[mint_token_symbol.toUpperCase()]) {
        tokenAddr = TOKEN_NAME_TO_ADDRESS[mint_token_symbol.toUpperCase()].toLowerCase();
      }

      let ethValue = await getRealDexPriceForToken(total, tokenAddr);
      if (!ethValue) {
        const fallback = await getEthPriceFromToken(tokenAddr);
        ethValue = fallback ? total * fallback : null;
      }

      const embed = new EmbedBuilder()
        .setTitle(`✨ NEW ${name.toUpperCase()} MINTS!`)
        .setDescription(`Minted by: ${shortWalletLink(newMints[0].to)}`)
        .addFields(
          { name: '🆔 Token IDs', value: newMints.map(m => `#${m.tokenId}`).join(', '), inline: false },
          { name: `💰 Spent (${mint_token_symbol})`, value: total.toFixed(4), inline: true },
          { name: `⇄ ETH Value`, value: ethValue ? `${ethValue.toFixed(4)} ETH` : 'N/A', inline: true },
          { name: '🔢 Total Minted', value: `${newMints.length}`, inline: true }
        )
        .setThumbnail(newMints[0].imageUrl)
        .setColor(219139)
        .setFooter({ text: `Live on Base • Powered by PimpsDev` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('🔗 View on OpenSea')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://opensea.io/assets/base/${address}/${newMints[0].tokenId}`)
      );

      await sendToUniqueGuilds(channel_ids, embed, row);
    }

    // === SALE EMBED ===
    for (const sale of newSales) {
      const tokenIdStr = sale.tokenId.toString();

      let imageUrl = 'https://via.placeholder.com/400x400.png?text=SOLD';
      let tokenAmount = null;
      let ethValue = null;
      let methodUsed = null;

      try {
        let uri = await contract.tokenURI(sale.tokenId);
        if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
        const meta = await fetch(uri, { timeout: 3000 }).then(res => res.json());
        if (meta?.image) {
          imageUrl = meta.image.startsWith('ipfs://')
            ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
            : meta.image;
        }
      } catch {}

      let receipt, tx;
      try {
        receipt = await provider.getTransactionReceipt(sale.transactionHash);
        tx = await provider.getTransaction(sale.transactionHash);
        if (!receipt || !tx) continue;
      } catch {
        continue;
      }

      if (tx.value && tx.value > 0n) {
        tokenAmount = parseFloat(ethers.formatEther(tx.value));
        ethValue = tokenAmount;
        methodUsed = '🟦 ETH';
      }

      if (!ethValue) {
        const transferTopic = id('Transfer(address,address,uint256)');
        const seller = ethers.getAddress(sale.from);

        for (const log of receipt.logs) {
          if (
            log.topics[0] === transferTopic &&
            log.topics.length === 3 &&
            log.address !== address
          ) {
            try {
              const to = ethers.getAddress('0x' + log.topics[2].slice(26));
              if (to.toLowerCase() === seller.toLowerCase()) {
                const tokenContract = log.address;
                tokenAmount = parseFloat(ethers.formatUnits(log.data, 18));
                ethValue = await getRealDexPriceForToken(tokenAmount, tokenContract);

                if (!ethValue) {
                  const fallback = await getEthPriceFromToken(tokenContract);
                  ethValue = fallback ? tokenAmount * fallback : null;
                }

                methodUsed = `🟨 ${mint_token_symbol}`;
                break;
              }
            } catch {}
          }
        }
      }

      if (!tokenAmount || !ethValue) continue;

      const embed = new EmbedBuilder()
        .setTitle(`💸 NFT SOLD – ${name} #${sale.tokenId}`)
        .setDescription(`Token \`#${sale.tokenId}\` just sold!`)
        .addFields(
          { name: '👤 Seller', value: shortWalletLink(sale.from), inline: true },
          { name: '🧑‍💻 Buyer', value: shortWalletLink(sale.to), inline: true },
          { name: `💰 Paid`, value: `${tokenAmount.toFixed(4)}`, inline: true },
          { name: `⇄ ETH Value`, value: `${ethValue.toFixed(4)} ETH`, inline: true },
          { name: `💳 Method`, value: methodUsed || 'Unknown', inline: true }
        )
        .setURL(`https://opensea.io/assets/base/${address}/${sale.tokenId}`)
        .setThumbnail(imageUrl)
        .setColor(0x66cc66)
        .setFooter({ text: 'Powered by PimpsDev' })
        .setTimestamp();

      await sendToUniqueGuilds(channel_ids, embed);
    }

    if (blockNumber % 10 === 0) {
      saveJson(seenPath(name), [...seenTokenIds]);
      saveJson(seenSalesPath(name), [...seenSales]);
    }
  });
}
// === FORMATTER: Short wallet → clickable ===
function shortWalletLink(addr) {
  const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  return `[${short}](https://opensea.io/${addr})`;
}

// === BOOT ON READY ===
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const result = await pg.query(`SELECT * FROM contract_watchlist`);
  for (const row of result.rows) {
    await trackContract(row); // multi-server support
  }
});

// === INTERACTION HANDLER ===
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, channel, member } = interaction;

  if (commandName === 'trackmint') {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    }

    const name = options.getString('name');
    const address = options.getString('address');
    const mint_price = options.getNumber('price');
    const tokenSymbol = options.getString('token') || 'ETH';
    const resolvedSymbol = tokenSymbol.toUpperCase();
    const tokenAddr = TOKEN_NAME_TO_ADDRESS[resolvedSymbol] || tokenSymbol;
    const currentChannel = channel.id;

    const res = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);

    if (res.rows.length > 0) {
      const existing = res.rows[0].channel_ids || [];
      const channel_ids = [...new Set([...existing, currentChannel])];

      await pg.query(
        `UPDATE contract_watchlist SET channel_ids = $1 WHERE name = $2`,
        [channel_ids, name]
      );

      const updated = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);
      await trackContract(updated.rows[0]);

      return interaction.reply(`✅ Updated tracking for **${name}** and added this channel.`);
    }

    const channel_ids = [currentChannel];

    await pg.query(
      `INSERT INTO contract_watchlist (name, address, mint_price, mint_token, mint_token_symbol, channel_ids)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [name, address, mint_price, tokenAddr, resolvedSymbol, channel_ids]
    );

    const newRow = {
      name,
      address,
      mint_price,
      mint_token: tokenAddr,
      mint_token_symbol: resolvedSymbol,
      channel_ids
    };

    await trackContract(newRow);

    return interaction.reply(`✅ Now tracking **${name}** using token \`${resolvedSymbol}\`.`);
  }

  if (commandName === 'untrackmint') {
    const name = options.getString('name');
    await pg.query(`DELETE FROM contract_watchlist WHERE name = $1`, [name]);
    interaction.reply(`🛑 Stopped tracking **${name}**.`);
  }

  if (commandName === 'channels') {
    const name = options.getString('name');
    const result = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);
    if (!result.rows.length) return interaction.reply({ content: `❌ Contract not found.`, ephemeral: true });

    const ids = result.rows[0].channel_ids;
    interaction.reply(`🔔 **${name}** alerts go to:\n${ids.map(id => `<#${id}>`).join(', ')}`);
  }

  if (commandName === 'untrackchannel') {
    const name = options.getString('name');
    const result = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);
    if (!result.rows.length) return interaction.reply({ content: `❌ Contract not found.`, ephemeral: true });

    const filtered = result.rows[0].channel_ids.filter(id => id !== channel.id);
    await pg.query(`UPDATE contract_watchlist SET channel_ids = $1 WHERE name = $2`, [filtered, name]);
    interaction.reply(`✅ Removed this channel from **${name}** alerts.`);
  }
  if (commandName === 'mintest') {
    const result = await pg.query(`SELECT * FROM contract_watchlist`);
    const filtered = result.rows.filter(row => row.channel_ids.includes(channel.id));
    if (!filtered.length) {
      return interaction.reply('❌ No tracked contracts for this channel.');
    }

    for (const { name, address, mint_price, mint_token, mint_token_symbol } of filtered) {
      const fakeQty = 3;
      const tokenAmount = mint_price * fakeQty;

      let ethValue = await getRealDexPriceForToken(tokenAmount, mint_token);
      if (!ethValue) {
        const fallback = await getEthPriceFromToken(mint_token);
        ethValue = fallback ? tokenAmount * fallback : null;
      }

      const embed = new EmbedBuilder()
        .setTitle(`🧪 Simulated Mint: ${name}`)
        .setDescription(`Minted by: ${shortWalletLink('0xFAKEWALLET123456789')}`)
        .addFields(
          { name: '🆔 Token IDs', value: '#1, #2, #3', inline: false },
          { name: `💰 Spent (${mint_token_symbol})`, value: tokenAmount.toFixed(4), inline: true },
          { name: `⇄ ETH Value`, value: ethValue ? `${ethValue.toFixed(4)} ETH` : 'N/A', inline: true },
          { name: '🔢 Total Minted', value: `${fakeQty}`, inline: true }
        )
        .setThumbnail('https://via.placeholder.com/400x400.png?text=Mint')
        .setColor(0x3498db)
        .setFooter({ text: 'Simulation Mode • Not Real' })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('🔗 View on OpenSea')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://opensea.io/assets/base/${address}/1`)
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
    }

    return interaction.reply({ content: '✅ Mint test sent.', ephemeral: true });
  }

  if (commandName === 'selltest') {
    const fake = {
      seller: '0xSELLERFAKE000000000000000000000000000000',
      buyer: '0xBUYERFAKE000000000000000000000000000000',
      tokenId: 123,
      amount: 0.0242,
      currency: 'ETH',
      contract: '0xc38e2ae060440c9269cceb8c0ea8019a66ce8927'
    };

    let imageUrl = 'https://via.placeholder.com/400x400.png?text=SOLD';

    try {
      const uri = await new Contract(fake.contract, ['function tokenURI(uint256) view returns (string)'], provider).tokenURI(fake.tokenId);
      const resolvedUri = uri.startsWith('ipfs://') ? uri.replace('ipfs://', 'https://ipfs.io/ipfs/') : uri;
      const meta = await fetch(resolvedUri).then(res => res.json());
      if (meta?.image) {
        imageUrl = meta.image.startsWith('ipfs://')
          ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
          : meta.image;
      }
    } catch (e) {
      console.warn(`⚠️ selltest image fetch failed: ${e.message}`);
    }

    const embed = new EmbedBuilder()
      .setTitle(`💸 Sale Alert – CryptoPimps #${fake.tokenId}`)
      .setDescription(`NFT has been sold!`)
      .addFields(
        { name: '👤 Seller', value: shortWalletLink(fake.seller), inline: true },
        { name: '🧑‍💻 Buyer', value: shortWalletLink(fake.buyer), inline: true },
        { name: `💰 Paid (${fake.currency})`, value: `${fake.amount}`, inline: true }
      )
      .setURL(`https://opensea.io/assets/base/${fake.contract}/${fake.tokenId}`)
      .setThumbnail(imageUrl)
      .setColor(0x66cc66)
      .setFooter({ text: `Simulated • Not real sale` })
      .setTimestamp();

    await interaction.channel.send({ embeds: [embed] });
    return interaction.reply({ content: '✅ Sent simulated sale alert.', ephemeral: true });
  }

  if (commandName === 'helpmint') {
    const helpEmbed = new EmbedBuilder()
      .setTitle('📖 Mint Bot Help Menu')
      .setDescription('Master the art of mint and sale tracking 🔍🧪')
      .addFields(
        { name: '📌 /trackmint', value: 'Track a contract with token + price' },
        { name: '🚫 /untrackmint', value: 'Stop tracking a contract' },
        { name: '📡 /channels', value: 'See all alert channels for a contract' },
        { name: '📤 /untrackchannel', value: 'Unsubscribe this channel' },
        { name: '🧪 /mintest', value: 'Simulate a mint' },
        { name: '💸 /selltest', value: 'Simulate a sale' },
        { name: '🆘 /helpmint', value: 'Show help menu' }
      )
      .setColor(0x00b0f4)
      .setThumbnail('https://iili.io/3PMk5GV.jpg')
      .setFooter({ text: 'Base Network • Mint & Sale Bot by PimpsDev' })
      .setTimestamp();

    return interaction.reply({ embeds: [helpEmbed], ephemeral: true });
  }
});

// === LOGIN ===
client.login(process.env.DISCORD_BOT_TOKEN);
