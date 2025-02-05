// Hedera transaction latency measurement.  
// Sending transaction using javascript sdk: https://github.com/hashgraph/hedera-sdk-js/blob/main/examples/transfer-tokens.js
// Fee Calculation: https://docs.hedera.com/guides/mainnet/fees
const fs = require('fs');
const AWS = require('aws-sdk');
const parquet = require('parquetjs-lite');
const axios = require("axios");
const moment = require('moment');
const { TransferTransaction, Client, AccountBalanceQuery, NetworkVersionInfoQuery, Status } = require ("@hashgraph/sdk");
const CoinGecko = require('coingecko-api');
const CoinGeckoClient = new CoinGecko();
const {Storage} = require('@google-cloud/storage');
require('dotenv').config();

//Build your Hedera client: https://docs.hedera.com/guides/docs/sdks/client
const client = process.env.NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet(); 

async function makeParquetFile(data) {
    var schema = new parquet.ParquetSchema({
        executedAt:{type:'TIMESTAMP_MILLIS'},
        txhash:{type:'UTF8'},
        startTime:{type:'TIMESTAMP_MILLIS'},
        endTime:{type:'TIMESTAMP_MILLIS'},
        chainId:{type:'INT64'},
        latency:{type:'INT64'},
        error:{type:'UTF8'},
        txFee:{type:'DOUBLE'},
        txFeeInUSD:{type:'DOUBLE'},
        resourceUsedOfLatestBlock:{type:'INT64'},
        numOfTxInLatestBlock:{type:'INT64'},
        pingTime:{type:'INT64'}
    })
  
    var d = new Date()
    //20220101_032921
    var datestring = moment().format('YYYYMMDD_HHmmss')
  
    var filename = `${datestring}_${data.chainId}.parquet`
  
    // create new ParquetWriter that writes to 'filename'
    var writer = await parquet.ParquetWriter.openFile(schema, filename);
  
    await writer.appendRow(data)
  
    await writer.close()
  
    return filename;
}
  
async function sendSlackMsg(msg) {
    axios.post(process.env.SLACK_API_URL, {
        'channel':process.env.SLACK_CHANNEL,
        'mrkdown':true,
        'text':msg
    }, {
        headers: {
            'Content-type':'application/json',
            'Authorization':`Bearer ${process.env.SLACK_AUTH}`
        }
    })
}
  
async function uploadToS3(data){
    if(process.env.S3_BUCKET === "") {
        throw "undefined bucket name"
    }

    const s3 = new AWS.S3();
    const filename = await makeParquetFile(data)
    const param = {
        'Bucket':process.env.S3_BUCKET,
        'Key':filename,
        'Body':fs.createReadStream(filename),
        'ContentType':'application/octet-stream'
    }
    await s3.upload(param).promise()
  
    fs.unlinkSync(filename) 
}

async function uploadToGCS(data) {
    if(process.env.GCP_PROJECT_ID === "" || process.env.GCP_KEY_FILE_PATH === "" || process.env.GCP_BUCKET === "") {
        throw "undefined parameters"
    }

    const storage = new Storage({
            projectId: process.env.GCP_PROJECT_ID,
            keyFilename: process.env.GCP_KEY_FILE_PATH
    });

    const filename = await makeParquetFile(data)
    const destFileName = `tx-latency-measurement/hedera/${filename}`;

    async function uploadFile() {
        const options = {
          destination: destFileName,
    };

    await storage.bucket(process.env.GCP_BUCKET).upload(filename, options);
    console.log(`${filename} uploaded to ${process.env.GCP_BUCKET}`);
  }

    await uploadFile().catch(console.error);
    fs.unlinkSync(filename)
}

async function uploadChoice(data) {
    if (process.env.UPLOAD_METHOD === "AWS") {
        await uploadToS3(data)
    }
    else if  (process.env.UPLOAD_METHOD === "GCP") {
        await uploadToGCS(data)
    }
    else {
        throw "Improper upload method"
    }
}

async function sendTx(){
    var data = {
        executedAt: new Date().getTime(),
        txhash: '',
        startTime: 0,
        endTime: 0,
        chainId: process.env.CHAIN_ID,
        latency:0,
        error:'',
        txFee: 0.0, 
        txFeeInUSD: 0.0, 
        resourceUsedOfLatestBlock: 0,
        numOfTxInLatestBlock: 0,
        pingTime:0 
    }
    
    try{
        const startNetworkInfo = new Date().getTime()
        await new NetworkVersionInfoQuery().execute(client); // Fee for requesting a network version info: $0.001
        const endNetworkInfo = new Date().getTime()
        data.pingTime = endNetworkInfo - startNetworkInfo

        const balance = await new AccountBalanceQuery() // Requesting an account balance is currently free: $0.000
            .setAccountId(client.operatorAccountId)
            .execute(client);
        
        const accountID = client.operatorAccountId.toString()

        if(balance.hbars.toBigNumber().toNumber() < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_HBAR))
        {
            sendSlackMsg(`Current balance of <${process.env.SCOPE_URL}/account/${accountID}|${accountID}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_HBAR} HBAR! balance=${balance.hbars.toBigNumber().toNumber()} HBAR`)
        }

        // Create and sign transaction : https://github.com/hashgraph/hedera-sdk-js/blob/main/examples/sign-transaction.js
        // The sender and recipient values must net zero.
        const transferTransaction = await new TransferTransaction()
            .addHbarTransfer(client.operatorAccountId, 10)
            .addHbarTransfer(client.operatorAccountId, -10)
            .freezeWith(client)
            .signWithOperator(client);

        const start = new Date().getTime()
        data.startTime = start
        // Execute transaction and wait until receipt is available. 
        // Fee for transaction: $0.0001
        const txResponse = await transferTransaction.execute(client) 
        const receipt = await txResponse.getReceipt(client);
        var consensusStatus = receipt.status.toString();
        if (consensusStatus == Status.Unknown.toString())
        {
            const receipt1 = await txResponse.getReceipt(client);
            consensusStatus = receipt1.status.toString();
            if (consensusStatus == Status.Unknown.toString())
            {
                const receipt2 = await txResponse.getReceipt(client);
                consensusStatus = receipt2.status.toString();
            }
        }

        if (consensusStatus != Status.Success.toString())
        {
            //throw error
            throw new Error(`Consensus status in transaction receipt is ${consensusStatus}`)
        }
        
        const end = new Date().getTime()
        data.endTime = end
        data.latency = end-start
        data.txhash = txResponse.transactionId.toString()

        const record = await txResponse.getRecord(client); // Fee for getting tx record: $0.0001
        data.txFee = record.transactionFee.toBigNumber().toNumber()

        // Calculate Transaction Fee and Get Tx Fee in USD 
        var HBARtoUSD; 
        await CoinGeckoClient.simple.price({
            ids: ["hedera-hashgraph"],
            vs_currencies: ["usd"]
        }).then((response)=>{
            HBARtoUSD = response.data["hedera-hashgraph"]["usd"]
        })
        data.txFeeInUSD = data.txFee * HBARtoUSD
        // console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)    
    } catch(err){
        console.log("failed to execute.", err.toString())
        data.error = err.toString()
        // console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.txFee},${data.txFeeInUSD},${data.resourceUsedOfLatestBlock},${data.numOfTxInLatestBlock},${data.pingTime},${data.error}`)
    }
    try{
        await uploadChoice(data)
    } catch(err) {
        console.log(`failed to ${process.env.UPLOAD_METHOD === 'AWS' ? 's3' : 'gcs'}.upload!! Printing instead!`, err.toString())
        console.log(JSON.stringify(data))
    }
}

async function main(){
    const start = new Date().getTime()
    console.log(`starting tx latency measurement... start time = ${start}`)

    if (process.env.PRIVATE_KEY === ""){
        console.log(`Private key is not defined.`)
        console.log(`Create a new Account on this website: https://portal.hedera.com/register`)
        console.log(`Then update ACCOUNT_ID and PRIVATE_KEY in .env file.`)
        return;
    }

    client.setOperator(process.env.ACCOUNT_ID, process.env.PRIVATE_KEY);

    // run sendTx every SEND_TX_INTERVAL
    const interval = eval(process.env.SEND_TX_INTERVAL)
    setInterval(()=>{
      sendTx()
    }, interval)
}

main();