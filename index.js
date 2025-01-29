import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { stringify } from 'csv-stringify/sync';
import dotenv from 'dotenv';

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const DUNE_API_KEY = process.env.DUNE_API_KEY;
const QUERY_ID = process.env.QUERY_ID;

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

  const response = await axios.post(`https://api.dune.com/api/v1/query/${QUERY_ID}/execute`, {
    query_parameters: params
  }, {
    headers: {
      'x-dune-api-key': DUNE_API_KEY
    }
  });

  if (response.data.state !== 'QUERY_STATE_COMPLETED') {
    throw new Error('Query execution failed');
  }

  return response.data.result.rows;
}

console.log('Coresight bot is running...');