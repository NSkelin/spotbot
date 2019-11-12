//---------- start setup //testchange4
require('dotenv').config();
var logger = require('winston');
// Configure logger settings
logger.remove(logger.transports.Console);
logger.add(new logger.transports.Console, {
    colorize: true
});
logger.level = 'debug';

// Initialize Discord Bot
const Discord = require('discord.io');
const bot = new Discord.Client({
   token: process.env.DISCORD_BOT_TOKEN,
   autorun: true
});

// webhook listener setup
const http = require('http');
const crypto = require('crypto');
const request = require('request');
const express = require('express');
const app = express();
const bodyParser = require('body-parser');
app.use(bodyParser.json());
app.use(bodyParser.text());
const exec = require('child_process').exec;

// amazon aws cli setup
var awsCli = require('aws-cli-js');
var Options = awsCli.Options;
var Aws = awsCli.Aws;
var options = new Options(
  /* accessKey    */ process.env.AWS_USER_ACCESS_KEY,
  /* secretKey    */ process.env.AWS_USER_SECRET_KEY,
  /* sessionToken */ null,
  /* currentWorkingDirectory */ null
);
var aws = new Aws(options);

//global variables
const s3BucketName = process.env.AWS_S3_BUCKET_NAME;
const startCommands = require('./startCommands.json')
const Server = require('./server.js');
const repo = process.env.REPO_PATH;
var servers = [];
var githubUpdatePending = false;
//---------- end setup

/**
* Returns all server names, which are the names of folders in the server s3 bucket.
* @returns {promise} Promise object represents an array of strings containing server names.
*/ 
function getServers () {
	return new Promise((resolve) => {
		aws.command('s3 ls '+s3BucketName).then((output) => {
			var output = output.raw;
			output = output.replace(/PRE| |\n/g,'');
			output = output.slice(0,-1);
			output = output.split('/');
			resolve(output)
		})
	})
}
/**
* Checks if the server files exists on the s3 bucket.
* @param {string} serverName - Name of the server to be looked for.
*/ 
function checkForServer(serverName) {
	return new Promise((resolve, reject) => {
		getServers()
		.then((servers) => {
			for (i=0; i<servers.length; i++) {
				if (serverName === servers[i]) {
					resolve();
					return
				}
			}
			reject('Server doesnt exist, try !servers')
		})
	});
}

// Searchs through Servers array for the server with the matching serverName and returns it
function getServer(serverName) {
	return new Promise((resolve, reject) => {
		for (i=0; i<servers.length; i++) {
			if (servers[i].name === serverName || servers[i].alias === serverName) {
				resolve(servers[i]);
				return
			}
		}
		reject(serverName+ " isn't on, try \"!start\"");
	});
}
// gets server config from server details file
function getServerDetails(serverName) {
	return new Promise((resolve,reject) => {
		for(let i=0; i<startCommands.length; i++) {
			if (serverName=== startCommands[i].name || serverName === startCommands[i].alias) {
				resolve(startCommands[i]);
				return
			}
		}
		reject('Couldnt find '+ serverName +' try "!servers"');
	});
}

// gathers all existing instances from aws and turns them into server class objects.
async function getRunningInstances() {
	//get instances
	let instances = await aws.command('ec2 describe-instances --query "Reservations"');
	instances = instances.object;
	//for each instance
	for (let i=0; i<instances.length; i++) {
		var instance = instances[i].Instances[0];
		var tags = instance.Tags;
		//check if the instance name matchs any json in startCommands.
		if(tags === undefined) {continue}
		for (let n=0; n<tags.length; n++) {
			if (tags[n].Key === 'Name') {
				let name = tags[n].Value;
				try {
					//set server details (ip, name, status)
					let startCommand = await getServerDetails(name);
					let instanceId = instance.InstanceId;
					let status = instance.State.Name;
					let ip = instance.PublicIpAddress;
					//if server is running add to servers global array
					if (status === 'running' || status === 'pending') {
						let server = new Server(name, startCommand, ip, status, instanceId);
						servers.push(server);
					}
				} catch(err) {
					console.log(err);
				}
			}
		}
	}
}

// checks if there is an argument, rejects with an error message.
function checkForArg(arg) {
	return new Promise((resolve, reject) => {
		if (arg === undefined) {
	    	reject('Invalid command. Use "!help" for more information.');
		} else {
			resolve();
		}
	});
}

async function startUp() {
	try {
		console.log('Spotbot Starting...');
		await getRunningInstances();
		console.log('Spotbot Started.');
	} catch (err) {
		console.log(err);
		process.exit();
	}
}

function sleep (ms) {
	return new Promise(
		resolve => setTimeout(resolve, ms)
	);
}

function runCmd (cmd) {
	return new Promise((resolve, reject) => {
		exec(cmd, (err, stdout, stderr) => {
    		console.log('stdout ', stdout);
    		console.log('stderr ', stderr);
    		resolve();
		});
	});
}

startUp();
app.post('/githubWebhook', async (req, res) => {
	res.send('ok');
    let sig = "sha1=" + crypto.createHmac('sha1', process.env.GITHUB_REPO_WEBHOOK_SECRET).update(JSON.stringify(req.body)).digest('hex');
    let branch = req.body.ref;
    // if secret keys match and the branch is master
    if (req.headers['x-hub-signature'] === sig && branch === 'refs/heads/master') {
    	githubUpdatePending = true;
    	// if servers init, wait...
    	while (true) {
    		let serverStarting = false;
    		for (let i=0; i < servers.length; i++) {
	    		let server = servers[i];
	    		console.log('server status ', server.starting);
	    		if (server.starting) {
	    			console.log('Update postponed, '+server.name+ ' is currently initializing');
	    			await sleep(60000);
	    			serverStarting = true;
	    		}
	    	}
	    	if(!serverStarting) {
	    		break;
	    	}
    	}
    	await runCmd('cd '+ repo +' && git pull');
        process.exit();
    }
});

app.post('/awsWebhook', async (req, res) => {
	var body = JSON.parse(req.body);
	if (req.headers['x-amz-sns-message-type'] === 'SubscriptionConfirmation') {
		let URL = body['SubscribeURL'];
		request(URL, (err, res) => {
			if (err) {
				console.log(err);
			} else if (res.statuscode === 200) {
				console.log('subscription confirmed');
			}
		})
	} else if (req.headers['x-amz-sns-message-type'] === 'Notification') {
		let message = JSON.parse(body.Message);
		let state = message.detail['state'];
		let instanceId = message.detail['instance-id'];
		if (state === 'shutting-down') {
			servers = servers.filter(server => server.instanceId != instanceId);
		}
	}
	res.send('ok');
})

app.listen(process.env.SERVER_PORT, () => {
	console.log('listening for webhooks on port ' + process.env.SERVER_PORT);
});

bot.on('message', async(user, userID, channelID, message, evt) => {
    if (message.substring(0, 1) == '!') {
        var args = message.substring(1).split(' ');
        var command = args[0];
        switch(command) {
        	case 'help':
        		if (args[1]) {
        			switch(args[1]) {
        				case'servers':
        					bot.sendMessage({
		                    	to: channelID,
		                    	message: '__**Command:**__\n!servers\n\n__**Description:**__\nWill display the name and alias '+
		                    	'of every server we currently offer into an easy to read format such as:\n\n'+
		                    	'|  server name 1 (sn1) |  server name 2 (sn2) |\n\n'+
		                    	'You can then use either the name (in this case "server name 1" or "server name 2") '+
		                    	'or the alias (in this case, "sn1" or "sn2") with any command that requires "<servername>".'
		                	});
        				break;
        				case'start':
        					bot.sendMessage({
		                    	to: channelID,
		                    	message: '__**Command:**__\n!start <servername>\n\n__**Parameters:**__\n<servername> - '+
		                    	'Name or alias of the server.\n\n__**Examples:**__\n!start minecraft_vanilla\n!start mcv\n\n'+
		                    	'__**Description:**__\n'+
		                    	'Starts a server depending on the server name/alias you put inside "<servername>". '+
		                    	'For example, if you put "!start minecraft_vanilla" a minecraft vanilla server will begin to start up '+
		                    	'(use "!servers" For a list of the available servers). Any running server will automatically create '+
		                    	'a backup every 30 minutes. The server will also automatically shut off if no one has been connected for '+
		                    	'the past 40 minutes.\n\nAfter you start a server, spotbot will '+
		                    	'periodically update you with the servers status as its starting up. Secondly you will be unable to start '+
		                    	'another server until the current one is offline.'
		                	});
        				break;
        				case'ip':
        					bot.sendMessage({
		                    	to: channelID,
		                    	message: '__**Command:**__\n!ip <servername>\n\n__**Parameters:**__\n<servername> - Name or alias of '+
		                    	'the server.\n\n__**Examples:**__\n!ip minecraft_vanilla\n!ip mcv\n\n__**Description:**__\n'+
		                    	'This command displays the ip of the server with the name/alias entered in <servername>. If the server '+
		                    	'isnt on, you will get a message such as "server not up!". You can use the ip to connect to the server '+
		                    	'(as long as it is currently running and '+
		                    	'finished starting). Use "!status <servername>" to find out if the server is ready.'
		                	});
        				break;
        				case'status':
        				    bot.sendMessage({
		                    	to: channelID,
		                    	message: '**Description:**\n*Tells you the status of a server.*\n\n'+
		                    	'**Command:**\n!status <servername>\n\n**Parameters:**\n<servername> - Name or alias '+
		                    	'of the server.\n\n**Examples:**\n!status minecraft_vanilla\n!status mcv\n\n**Details:**\n'+
		                    	'This command will find and then displays the status of the server. Specifically it will find '+
		                    	'if the computer is on, is the computer starting, is the server on, or is the server starting. '+
		                    	'After this is done it will then tell you the status based on its findings.'
		                	});
        				break;
        				case'restart':
        					bot.sendMessage({
		                    	to: channelID,
		                    	message: '__**Command:**__\n!restart <servername>\n\n__**Parameters:**__\n<servername> - Name or alias '+
		                    	'of the server.\n\n__**Examples:**__\n!restart minecraft_vanilla\n!restart mcv\n\n'+
		                    	'!restart mcv\n__**Description:**__\n'+
		                    	'This command attempts to restart the server after checking if it is offline. It doesnt not check after '+
		                    	'restarting to see if the server is up. Use !status <servername> instead.'
		                	});
        				break;
        				default:
        					bot.sendMessage({
		                    	to: channelID,
		                    	message: 'Error, unknown parameter, try one of these:\n'+
		                    	'!help servers\n!help start\n!help ip\n!help status\n!help restart\n'
		                	});
        				break;
        			}
        		} else {
        			bot.sendMessage({
                    	to: channelID,
                    	message: 'Hi, Heres the current list of commands:\n'+
                    	'!help <command>\n!servers\n!start <servername>\n!ip <servername>\n!status <servername>\n!restart <servername>\n'+
                    	'Also their are 6 easter egg commands. Can you find them all?\n'+
                    	'in <>, such as <servername> are variables. In these you must put in what is asked, for example, !start <servername>'+
                    	' can be "!start minecraft_vanilla"\n\n'+
                    	'If you want to know more about a specific command you can also type "!help <command>".'
                    	+'Where "<command>" is you would put the name of the command you want help with, for example "!help start".'
                	});
        		}
        	break;
            case 'ip':
            	// if there is no input besides !ip then tell the user to enter a game
        		try {
        			await checkForArg(args[1]);
        			await getServerDetails(args[1]);
        			server = await getServer(args[1]);
            		bot.sendMessage({
	                    to: channelID,
	                    message: server.ip
	            	});
        		} catch(err) {
            		bot.sendMessage({
	                    to: channelID,
	                    message: err
	            	});
        		}
            break;
            case 'start':
        		try {
        			if (!githubUpdatePending) {
	        			await checkForArg(args[1]);
	        			let serverDetails = await getServerDetails(args[1]);
	        			bot.sendMessage({
		        			to: channelID,
		        			message: 'Acknowledged Captain! Were getting ready...'
		        		});

		        		let server = new Server(serverDetails.name, serverDetails);
	            		servers.push(server);
	            		await server.init();
		        		await server.startInstance();
		        		bot.sendMessage({
	            			to: channelID,
	            			message: 'Computer powering on!...'
	            		});

						server.createShutdownAlarm();
	            		server.createBackupEvents();
	            		await server.startServer();
						bot.sendMessage({
	            			to: channelID,
	            			message: 'Starting the game server now! You should be able to join in a few minutes, have fun!'
	    				});

	    				bot.sendMessage({
	            			to: channelID,
	            			message: '!ip ' + serverDetails.name
	    				});
        			} else {
        				bot.sendMessage({
		        			to: channelID,
		        			message: 'Bot restarting for maintenance soon. Please try again in a few minutes.'
			        	});
        			}
        		} catch(err) {
        			// remove server from servers array
        			bot.sendMessage({
	        			to: channelID,
	        			message: err
		        	});
		        	console.log(err);
        		}
            break;
            case 'status':
	            try {
	 				await checkForArg(args[1]);
		        	await getServerDetails(args[1]);

	    			bot.sendMessage({
		                to: channelID,
		                message: 'Searching!'
		        	});
		        	let server = await getServer(args[1]);
			        let status = await server.checkInstanceStatus();
	        		bot.sendMessage({
		                to: channelID,
		                message: status
		        	});
	            } catch(err) {
	            	bot.sendMessage({
	                    to: channelID,
	                    message: err
	                });
	            } 
            break;
            case 'restart':
	            try{
            	await checkForArg(args[1]);
        		await getServerDetails(args[1]);
	            bot.sendMessage({
	            	to: channelID,
	            	message: 'Checking server status first!'
	            })
	            	let server = await getServer(args[1]);
	            	var success = await server.restartServer(args[1])
	            	bot.sendMessage({
		            	to: channelID,
		            	message: success
	            	})
	            } catch(err) {
	            	bot.sendMessage({
		            	to: channelID,
		            	message: err
		            });
	            }
            break;
            case 'servers':
            	let msg = '';
            	let n = 0;
	            for (let i=0; i<startCommands.length; i++) {
	            	let name = startCommands[i].name;
	            	let alias = startCommands[i].alias;

	            	msg += name
        			msg += ' (' + alias + ') '
        			msg += '\t|\t' 
        			n+=1
	            	if (n === 5) {
	            		msg += '\n|\t'
	            		n = 0;
	            	}	
				}
        		bot.sendMessage({
        			to: channelID,
        			message: 'Heres the list of servers!\n|\t' + msg
        		});
            break;
            // easter eggs
            case 'ping':
                bot.sendMessage({
                    to: channelID,
                    message: 'Pong!'
                });
            break;
            case 'alex':
            	bot.sendMessage({
                    to: channelID,
                    message: 'Stole your RAM!'
                });
            break;
            case 'brownies':
            	bot.sendMessage({
                    to: channelID,
                    message: 'Eunk bwonoes'
                });
            break;
            case 'Oh?':
            	bot.sendMessage({
                    to: channelID,
                    message: "you're walking up to me!?"
                });
            break;
            case 'thx':
            	bot.sendMessage({
                    to: channelID,
                    message: 'butters'
                });
            break;
            case 'dood':
            	bot.sendMessage({
                    to: channelID,
                    message: 'No way DOOD!'
                });
            break;
     		default:
     			bot.sendMessage({
                    to: channelID,
                    message: 'Unknown command! try "!help" for a list of commands.'
                });
         }
     }
});