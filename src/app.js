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

  // Initialize WebAgent
  const agent = WebAgent.fromApiKey(process.env.AGP_API_KEY, {
    debug: true,
  });

  const vinted_url = 'https://www.vinted.fr';
  
  console.log('\n🔍 Starting parallel searches on Vinted...\n');

  // Define 4 different search strategies
  const searchStrategies = [
    {
      name: '🎯 Exact Match',
      prompt: `Search on Vinted for an EXACT match to this product: ${description}. Look for the same brand, model, color, and size. Return only the URL of the best exact match you find.`,
      priority: 1
    },
    {
      name: '✨ Close Alternative',
      prompt: `Search on Vinted for a product that is very similar to: ${description}. Same type and brand, but can have slight variations in color or minor features. Return only the URL of the best close match.`,
      priority: 2
    },
    {
      name: '🔄 Similar Style',
      prompt: `Search on Vinted for a product with similar style and features to: ${description}. Can be from a different brand but should have the same type, purpose, and general aesthetic. Return only the URL of the best similar item.`,
      priority: 3
    },
    {
      name: '💰 Budget Alternative',
      prompt: `Search on Vinted for a more affordable alternative to: ${description}. Should serve the same purpose but prioritize lower price while maintaining decent quality. Return only the URL of the best budget option.`,
      priority: 4
    }
  ];

  // Launch all searches in parallel using runBatch
  const tasks = await agent.runBatch(
    searchStrategies.map(strategy => ({
      objective: strategy.prompt,
      startUrl: vinted_url
    }))
  );

  // Attach listeners to each task
  tasks.forEach((task, index) => {
    const strategyName = searchStrategies[index].name;
    
    console.log(`Launched: ${strategyName} (Task ID: ${task.id})`);

    task.onStatusChange((status) => {
      console.log(`  ${strategyName}: ${status}`);
    });

    task.onChatMessage((message) => {
      if (message.data.type === 'answer') {
        console.log(`  ${strategyName}: Found answer`);
      }
    });
  });

  // Wait for all tasks to complete with 1 minute timeout
  console.log('\n⏳ Waiting for all agents to complete (max 1 minute)...\n');
  
  const TIMEOUT_MS = 60000; // 1 minute
  
  try {
    await Promise.race([
      agent.waitForAllComplete(tasks),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout: Tasks took more than 1 minute')), TIMEOUT_MS)
      )
    ]);
  } catch (error) {
    if (error.message.includes('Timeout')) {
      console.log('\n⚠️  Timeout reached! Stopping remaining tasks...\n');
      
      // Stop any tasks that are still running
      tasks.forEach((task, index) => {
        if (!['completed', 'failed'].includes(task.status)) {
          console.log(`  Stopping: ${searchStrategies[index].name}`);
          try {
            task.stopPolling();
          } catch (e) {
            // Ignore errors when stopping
          }
        }
      });
    } else {
      throw error;
    }
  }

  // Extract results from each task
  const results = tasks.map((task, index) => {
    const strategy = searchStrategies[index];
    
    // Extract the answer from chat messages
    let url = null;
    try {
      const chatMessages = task.getChatMessages();
      const answerMessage = chatMessages.find((msg) => msg.data?.type === 'answer');
      url = answerMessage?.data?.content || null;
    } catch (error) {
      console.error(`Error extracting answer for ${strategy.name}:`, error.message);
    }
    
    return {
      strategy: strategy.name,
      priority: strategy.priority,
      url: url,
      status: task.status,
      timedOut: !['completed', 'failed'].includes(task.status)
    };
  });

  // Display results ordered by priority (closest match first)
  console.log('\n' + '='.repeat(60));
  console.log('📋 SEARCH RESULTS (ordered by match relevance)');
  console.log('='.repeat(60) + '\n');

  results
    .sort((a, b) => a.priority - b.priority)
    .forEach((result, index) => {
      console.log(`${index + 1}. ${result.strategy}`);
      console.log(`   Status: ${result.status}${result.timedOut ? ' ⏱️  (TIMED OUT)' : ''}`);
      console.log(`   URL: ${result.url || 'No result found'}`);
      console.log('');
    });
})();