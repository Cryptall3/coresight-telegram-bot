import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { stringify } from 'csv-stringify/sync';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

// Create bot with polling disabled to avoid multiple instance conflicts
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
  polling: true,
  // Add error handling for polling
  onlyFirstMatch: true,
  request: {
    retryAfter: 5000
  }
});

// Create a simple HTTP server for health checks
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Health check passed');
});

// Listen on port 8000 (required by Koyeb)
server.listen(8000, () => {
  console.log('Health check server running on port 8000');
});

bot.onText(/\/coresight/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Please enter 1-5 Solana token addresses, separated by spaces:");

  bot.once('text', async (tokenMsg) => {
    const addresses = tokenMsg.text.split(' ');
    if (addresses.length < 1 || addresses.length > 5) {
      bot.sendMessage(chatId, "Please enter between 1 and 5 token addresses.");
      return;
    }

    try {
      const result = await queryDune(addresses);
      const csv = stringify(result, { header: true });
      
      bot.sendDocument(chatId, Buffer.from(csv), {
        filename: 'coresight_results.csv',
        caption: 'Here are your Coresight results:'
      });
    } catch (error) {
      bot.sendMessage(chatId, `Error: ${error.message}`);
    }
  });
});

async function queryDune(addresses) {
  const params = {};
  addresses.forEach((address, index) => {
    params[`Token_${index + 1}`] = address;
  });

  const response = await axios.post(`https://api.dune.com/api/v1/query/${process.env.QUERY_ID}/execute`, {
    query_parameters: params
  }, {
    headers: {
      'x-dune-api-key': process.env.DUNE_API_KEY
    }
  });

  if (response.data.state !== 'QUERY_STATE_COMPLETED') {
    throw new Error('Query execution failed');
  }

  return response.data.result.rows;
}

// Handle errors gracefully
bot.on('polling_error', (error) => {
  console.log('Polling error:', error.message);
  // If the error is a conflict, wait before reconnecting
  if (error.code === 'ETELEGRAM' && error.message.includes('Conflict')) {
    setTimeout(() => {
      bot.startPolling();
    }, 10000);
  }
});

console.log('Coresight bot is running...');