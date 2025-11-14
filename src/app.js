import { WebAgent } from '@h-company/agp-sdk-js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { CohereClient } from 'cohere-ai';

const input_url = process.argv[2];
if (!input_url) {
  console.error('Please provide a URL as argument');
  process.exit(1);
}

if (!process.env.COHERE_API_KEY) {
  console.error('COHERE_API_KEY not found in environment variables');
  process.exit(1);
}

(async () => {
  console.log('Fetching HTML from:', input_url);
  
  // Fetch the HTML using axios
  const response = await axios.get(input_url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  });
  
  // Parse HTML with cheerio
  const $ = cheerio.load(response.data);
  
  // Remove script and style tags
  $('script, style').remove();
  
  // Get text content from body
  const text = $('body').text().trim();
  console.log('Extracted text length:', text.length);
  console.log('First 200 chars:', text.substring(0, 200));
  
  // Initialize Cohere client
  const cohere = new CohereClient({
    token: process.env.COHERE_API_KEY,
  });

  console.log('\nSummarizing product description with Cohere...');
  const summary = await cohere.chat({
    model: 'command-a-03-2025',
    message: `Extract and summarize the key product information from this text. Focus on: product name, type, brand, key features, size, color, material, and any important specifications. Keep it concise and clear:\n\n${text}`,
  });

  const description = summary.text;
  console.log('Summary:', description);

  const agent = WebAgent.fromApiKey(process.env.AGP_API_KEY, {
    debug: true,
  });

  const vinted_url = 'https://www.vinted.fr';
  console.log('\nSearching on Vinted for matching product...');
  const task = await agent.run(
    `Find a second-hand product on Vinted that matches this description. If you do not find an exact match, give the url of the closest match: ${description}. Look for similar items in good condition at a reasonable price. Return only the URL of the best matching product.`,
    { startUrl: vinted_url }
  );

  task.onUpdate((event) => {
    console.log('Search:', event.type, event.data);
  });

  await task.waitForCompletion();
  console.log('Found URL:', task.answer);
})();