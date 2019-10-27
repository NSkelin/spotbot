require('dotenv').config();
var Discord = require('discord.io');
var logger = require('winston');
// Configure logger settings
logger.remove(logger.transports.Console);
logger.add(new logger.transports.Console, {
    colorize: true
});
logger.level = 'debug';
// Initialize Discord Bot
var bot = new Discord.Client({
   token: process.env.TOKEN,
   autorun: true
});

// amazon aws cli setup
var awsCli = require('aws-cli-js');
var Options = awsCli.Options;
var Aws = awsCli.Aws;
var options = new Options(
  /* accessKey    */ process.env.ACCESSKEY,
  /* secretKey    */ process.env.SECRETKEY,
  /* sessionToken */ null,
  /* currentWorkingDirectory */ null
);
var aws = new Aws(options);
const  s3BucketName = process.env.FOLDER;
const startCommands = require('./startCommands.json')
const Server = require('./server.js');
var servers = [];

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

startUp();

bot.on('message', async(user, userID, channelID, message, evt) => {
    if (message.substring(0, 1) == '!') {
        var args = message.substring(1).split(' ');
        var command = args[0];
        switch(command) {
        	case 'help':
        		bot.sendMessage({
                    to: channelID,
                    message: 'Hi, Heres the current list of commands:\n'+
                    '!start\n!ip\n!status\n!servers\n!restart\n'+
                    'Also their are 5 easter egg commands. Can you find them all?'
                });
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
        			await checkForArg(args[1]);
        			await getServerDetails(args[1]);
        			bot.sendMessage({
	        			to: channelID,
	        			message: 'Acknowledged Captain! Were getting ready...'
	        		});

	        		let serverDetails = await getServerDetails(args[1]);
	        		let server = new Server(serverDetails.name, serverDetails);
	        		await server.startInstance();
	        		bot.sendMessage({
            			to: channelID,
            			message: 'Computer powering on!...'
            		});

					server.createShutdownAlarm();
            		server.createBackupEvents();
            		await server.startServer();
            		servers.push(server);
					bot.sendMessage({
            			to: channelID,
            			message: 'Starting the game server now! You should be able to join in a few minutes, have fun!'
    				});
    				bot.sendMessage({
            			to: channelID,
            			message: '!ip ' + serverDetails.name
    				});
    				
        		} catch(err) {
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