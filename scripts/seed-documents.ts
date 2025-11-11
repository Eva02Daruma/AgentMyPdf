/**
 * Script para hacer seeding de documentos legales
 * 
 * Este script descarga los PDFs, extrae el texto y los sube al sistema RAG
 * 
 * Uso:
 * npx tsx scripts/seed-documents.ts
 */

// @ts-ignore - pdf-parse doesn't have proper TS types
import { PDFParse } from 'pdf-parse';

const WORKER_URL = "https://agentmypdf.dlaurenap.workers.dev"; // Production URL
const BATCH_SIZE = 1; // Número de chunks a procesar en paralelo (1 = secuencial, más confiable)
const RETRY_ATTEMPTS = 3; // Número de reintentos por chunk
const RETRY_DELAY = 2000; // Delay entre reintentos en ms
const CHUNK_SIZE = 600; // Tamaño de cada chunk en caracteres (reducido para evitar errores)

const DOCUMENTS = [
	{
		name: "Ley 19.886 - Compras Públicas",
		url: "https://pub-0e0e9ca0d502436bbf25ba03d6046c82.r2.dev/Ley-19886.pdf",
		source: "Ley-19886"
	},
	{
		name: "Ley 19.496 - Protección de los Consumidores",
		url: "https://pub-0e0e9ca0d502436bbf25ba03d6046c82.r2.dev/Ley-19496.pdf",
		source: "Ley-19496"
	},
	{
		name: "Ley 20.393 - Responsabilidad Penal de Personas Jurídicas",
		url: "https://pub-0e0e9ca0d502436bbf25ba03d6046c82.r2.dev/Ley-20393.pdf",
		source: "Ley-20393"
	},
	{
		name: "Ley 19.913 - UAF",
		url: "https://pub-0e0e9ca0d502436bbf25ba03d6046c82.r2.dev/Ley-19913.pdf",
		source: "Ley-19913"
	},
	{
		name: "Ley 21.521 - Fintec",
		url: "https://pub-0e0e9ca0d502436bbf25ba03d6046c82.r2.dev/Ley-21521.pdf",
		source: "Ley-21521"
	}
];

/**
 * Chunk text into smaller pieces for better embeddings
 */
function chunkText(text: string, maxLength: number = CHUNK_SIZE): string[] {
	const chunks: string[] = [];
	const sentences = text.split(/[.!?]\s+/);
	let currentChunk = "";

	for (const sentence of sentences) {
		if ((currentChunk + sentence).length > maxLength) {
			if (currentChunk) {
				chunks.push(currentChunk.trim());
			}
			currentChunk = sentence;
		} else {
			currentChunk += (currentChunk ? ". " : "") + sentence;
		}
	}

	if (currentChunk) {
		chunks.push(currentChunk.trim());
	}

	return chunks;
}

/**
 * Clean and sanitize text for JSON compatibility
 * Removes control characters and problematic unicode
 */
function sanitizeText(text: string): string {
	return text
		// Remove ALL control characters except space, newline, tab
		.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '')
		// Remove BOM and zero-width characters
		.replace(/[\uFEFF\uFFFD\u200B-\u200D\u2060]/g, '')
		// Normalize smart quotes and dashes
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010-\u2015]/g, '-')
		.replace(/[\u2026]/g, '...')
		// Replace degree symbol and other special chars
		.replace(/°/g, 'º')
		.replace(/№/g, 'N')
		// Normalize whitespace
		.replace(/\s+/g, ' ')
		.replace(/\n\s*\n/g, '\n')
		// Only keep safe printable characters
		.replace(/[^\x20-\x7E\xA0-\xFF\u0100-\u017F\u0180-\u024F\n\r\t]/g, ' ')
		.trim();
}

/**
 * Extract text from PDF using pdf-parse v2
 */
async function extractTextFromPDF(url: string): Promise<string> {
	console.log(`  📥 Downloading and parsing PDF from ${url}...`);
	
	try {
		// Create PDFParse instance with URL
		// @ts-ignore
		const parser = new PDFParse({ url: url });

		// Extract text
		// @ts-ignore
		const result = await parser.getText();

		console.log(`  ✅ Extracted ${result.text.length} characters`);

		// Clean and sanitize the text
		const cleanedText = sanitizeText(result.text);

		if (cleanedText.length < 100) {
			throw new Error("Extracted text is too short, PDF might be corrupted or image-based");
		}

		console.log(`  🧹 Cleaned text: ${cleanedText.length} characters`);
		return cleanedText;
	} catch (error) {
		console.error(`  ❌ Error extracting PDF:`, error);
		throw error;
	}
}

/**
 * Upload document chunk to the worker with retry logic
 */
async function uploadChunk(text: string, source: string, attempt = 1): Promise<void> {
	try {
		// Sanitize text one more time before sending
		const cleanText = sanitizeText(text);
		
		const response = await fetch(`${WORKER_URL}/seed`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify({ text: cleanText, source }),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Failed to upload chunk: ${error}`);
		}

		const result = await response.json();
		console.log(`    ✓ Uploaded chunk (ID: ${result.documentId})`);
	} catch (error) {
		if (attempt < RETRY_ATTEMPTS) {
			console.log(`  ⚠️  Upload failed, retrying in ${RETRY_DELAY}ms...`);
			await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
			await uploadChunk(text, source, attempt + 1);
		} else {
			console.error(`  ❌ Error uploading chunk:`, error);
			throw error;
		}
	}
}

/**
 * Process a single document
 */
async function processDocument(doc: typeof DOCUMENTS[0]): Promise<void> {
	console.log(`\n📄 Processing: ${doc.name}`);
	console.log(`   URL: ${doc.url}`);

	try {
		// Extract text from PDF
		console.log(`  📖 Extracting text...`);
		const text = await extractTextFromPDF(doc.url);

		// Chunk the text
		console.log(`  ✂️  Chunking text (${CHUNK_SIZE} chars per chunk)...`);
		const chunks = chunkText(text);
		console.log(`  📦 Created ${chunks.length} chunks`);

		// Upload chunks in parallel batches
		console.log(`  ⬆️  Uploading ${chunks.length} chunks (${BATCH_SIZE} at a time)...`);
		let uploadedCount = 0;
		
		for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
			const batch = chunks.slice(i, i + BATCH_SIZE);
			const batchPromises = batch.map((chunk, idx) => 
				uploadChunk(chunk, doc.source)  // Fixed: use doc.source directly, not with chunk number
			);
			
			await Promise.all(batchPromises);
			uploadedCount += batch.length;
			console.log(`    📊 Progress: ${uploadedCount}/${chunks.length} chunks uploaded`);
		}

		console.log(`  ✅ Successfully processed ${doc.name} (${chunks.length} chunks)`);
	} catch (error) {
		console.error(`  ❌ Error processing ${doc.name}:`, error);
		throw error;
	}
}

/**
 * Main function
 */
async function main() {
	console.log("🚀 Starting document seeding process...\n");
	console.log(`📍 Worker URL: ${WORKER_URL}`);
	console.log(`⚡ Batch size: ${BATCH_SIZE} chunks in parallel`);
	console.log(`🔄 Retry attempts: ${RETRY_ATTEMPTS}\n`);

	const startTime = Date.now();
	const results = {
		successful: [] as string[],
		failed: [] as string[]
	};

	// Process all documents sequentially, continue even if one fails
	for (const doc of DOCUMENTS) {
		try {
			await processDocument(doc);
			results.successful.push(doc.name);
		} catch (error) {
			console.error(`  ⚠️  Skipping ${doc.name}, will continue with others...`);
			results.failed.push(doc.name);
		}
	}

	const duration = ((Date.now() - startTime) / 1000).toFixed(2);

	console.log("\n" + "=".repeat(60));
	console.log("📊 SEEDING SUMMARY");
	console.log("=".repeat(60));
	console.log(`⏱️  Total time: ${duration}s`);
	console.log(`✅ Successful: ${results.successful.length}/${DOCUMENTS.length}`);
	
	if (results.successful.length > 0) {
		console.log("\n✅ Successfully processed:");
		results.successful.forEach(name => console.log(`   - ${name}`));
	}
	
	if (results.failed.length > 0) {
		console.log("\n❌ Failed:");
		results.failed.forEach(name => console.log(`   - ${name}`));
		console.log("\n💡 Tips to fix failures:");
		console.log("   1. Reduce BATCH_SIZE further (currently: " + BATCH_SIZE + ")");
		console.log("   2. Run script again - it will process all documents");
		console.log("   3. Check Vectorize limits in dashboard");
	} else {
		console.log("\n🎉 Knowledge base is ready!");
		console.log("\n💡 Next steps:");
		console.log("   curl -X POST http://localhost:8787/question -H 'Content-Type: application/json' -d '{\"question\":\"tu pregunta\"}'");
	}
}

// Run the script
main();
