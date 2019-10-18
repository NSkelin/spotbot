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
var startInstanceFunctionActive = false;
const startCommands = require('./startCommands.json')
// wait for x milliseconds
function sleep (ms) {
	return new Promise(
		resolve => setTimeout(resolve, ms)
	);
}
// user serverName var
function getIp (serverName, callback) {
	return new Promise((resolve, reject) => {
		aws.command('ec2 describe-instances '+
			'--filter "Name=tag:Name,Values='+serverName+'" '+
			'--query "Reservations[0].Instances[0].PublicIpAddress"')
		.then(function (data) {
			if (data.object === null) {
				reject('We couldnt find an IP! the server probably isnt up, so try !start or !status');
			} else {
				resolve(data.object);	
			}
		});
	})
}
// gets a instance id based on the tag name
function getInstanceId (serverName) {
	return new Promise((resolve, reject) => {
		aws.command('ec2 describe-instances '+
		'--filter "Name=tag:Name,Values=' + serverName +
		'" --query "Reservations[0].Instances[0].InstanceId"')
		.then(async (instanceId) => {
			if (instanceId.object === null) {
				reject('The computer isnt on, try !start.');
			} else {
				resolve(instanceId.object);
			}
		});
	})
}
// checks if the instance is running or not
function checkInstanceRunning (serverName) {
	return new Promise((resolve, reject) => {
		aws.command('ec2 describe-instances --filter "Name=tag:Name,Values=' + serverName + '" --query Reservations[0]')
		.then((serverStatus) => {
			// checks if the instance with serverName exists. If it does but is terminated or shutting down it removes the servers tag name (serverName)
			if (serverStatus.object != null) {
				var state = serverStatus.object.Instances[0].State.Name
				if (state === "shutting-down" || state === "terminated") {
					getInstanceId(serverName)
					.then((instanceId) => {
						aws.command('ec2 delete-tags --resources ' + instanceId + ' --tags Key=Name,Value=' + serverName);
					});
					resolve();
					return
				} else {
					reject();
					return
				}
			} else {
				resolve();
			}
		});
	});
}
// starts a spot instance and tags it
function startInstance (serverName) {
	// ##### Start Spot Instance #####
	return new Promise((resolve, reject) => {
		// figure out queues or someway to only allow one person to run this function at a time

		// is this function already running? reject if true, else continue
		if (startInstanceFunctionActive) {
			reject('Server is already being started');
			return
		} else {
			startInstanceFunctionActive = true;
			checkInstanceRunning(serverName)
			.then(async() => {
				// create spot instance and tag it
				aws.command('ec2 request-spot-instances '+
					'--availability-zone-group us-west-2 '+
					'--instance-count 1 '+
					'--launch-specification '+
						'\'{"ImageId": "ami-0cb72367e98845d43",'+
						'"KeyName": "Minecraft_Server",'+
						'"SecurityGroupIds": [ "'+startCommands[serverName].securityGroup+'" ],'+
						'"InstanceType": "'+startCommands[serverName].instanceType+'",'+
						'"IamInstanceProfile": {"Arn": "arn:aws:iam::392656794647:instance-profile/SSM-Agent"}}\''
				);
				await sleep(3500); // wait for amazon
				return aws.command('ec2 describe-instances '+
					'--filter "Name=instance-state-name,Values=pending" '+
					'--query "Reservations[0].Instances[0].InstanceId"')
			}).then((instanceId) => {
				aws.command('ec2 create-tags --resource ' + instanceId.object + ' --tags Key=Name,Value=' + serverName)
				startInstanceFunctionActive = false;
				resolve();
			}).catch(() => {
				startInstanceFunctionActive = false;
				reject('The computer is already on try !status or !ip');
			});
		}
	});
}
// creates a cloud watch alarm that terminates the instance if networkOut is below threshold (aka no players connected)
function createShutdownAlarm (serverName, instanceId) {
	aws.command('cloudwatch put-metric-alarm '+
	'--alarm-name "alarm when '+serverName+' server doesnt have anyone online for a time" '+
	'--alarm-description "Automatically shutoff the server if no one is connected" '+
	'--metric-name "NetworkOut" '+
	'--alarm-actions "arn:aws:automate:us-west-2:ec2:terminate" '+
	'--dimensions "Name=InstanceId,Value='+instanceId+'" '+
	'--evaluation-periods "8" '+
	'--datapoints-to-alarm "7" '+
	'--threshold "'+startCommands[serverName].threshold+'" '+
	'--comparison-operator "LessThanOrEqualToThreshold" '+
	'--period "300" '+
	'--namespace "AWS/EC2" '+
	'--statistic "Average"');
}
// creates amazon rules / events to handle backipng up the game server files
function createBackupEvents (serverName, instanceId) {
	// backup periodically (30min)
	aws.command("events put-rule "+
		"--name '"+serverName+"_periodic_backup' "+
		"--schedule-expression 'rate(30 minutes)' "+
		"--state 'ENABLED' "+
		"--description 'creates a backup periodically'")
	.then(() => {
		aws.command('events put-targets '+
		'--rule "'+serverName+'_periodic_backup" '+
		'--targets '+
		'"Id"="1",'+
		'"Arn"="arn:aws:ssm:us-west-2::document/AWS-RunShellScript",'+
		'"RunCommandParameters"="{RunCommandTargets={Key=InstanceIds,Values=[' + instanceId + ']}}",'+
		'"RoleArn"="arn:aws:iam::392656794647:role/Cloudwatch_run_commands",'+
		'"Input"=\'\"{\\\"commands\\\": [\\\"aws s3 cp ./server s3://' + s3BucketName + '/'+serverName+' --recursive\\\"],'+
		'\\\"workingDirectory\\\": [\\\"/home/ec2-user\\\"],'+
		'\\\"executionTimeout\\\": [\\\"3600\\\"]}\"\'');
	});

	// backup on ec2 spot termination
	aws.command('events put-rule --name "'+serverName+'_interrupt_backup" --event-pattern \'{\"source\":[\"aws.ec2\"],\"detail-type\":[\"EC2 Spot Instance Interruption Warning\"]}\' --state "ENABLED" --description "creates a backup when the instance terminates"')
	.then(() => {
		aws.command('events put-targets '+
		'--rule "'+serverName+'_interrupt_backup" '+
		'--targets '+
		'"Id"="1",'+
		'"Arn"="arn:aws:ssm:us-west-2::document/AWS-RunShellScript",'+
		'"RunCommandParameters"="{RunCommandTargets={Key=InstanceIds,Values=[' + instanceId + ']}}",'+
		'"RoleArn"="arn:aws:iam::392656794647:role/Cloudwatch_run_commands",'+
		'"Input"=\'\"{\\\"commands\\\": [\\\"aws s3 cp ./server s3://' + s3BucketName + '/'+serverName+' --recursive\\\"],'+
		'\\\"workingDirectory\\\": [\\\"/home/ec2-user\\\"],'+
		'\\\"executionTimeout\\\": [\\\"3600\\\"]}\"\'');
	});
}	
// loads the games files onto the instance and then runs them.
function startServer (serverName, instanceId) {
	return new Promise(async function(resolve) {
		while (true) {
			var check1;
			var check2;
			aws.command('ec2 describe-instance-status --instance-ids '+instanceId+' --query "InstanceStatuses[0].InstanceStatus.Status"')
			.then((data) => {
				check1 = data.object
			})
			aws.command('ec2 describe-instance-status --instance-ids '+instanceId+' --query "InstanceStatuses[0].SystemStatus.Status"')
			.then((data) => {
				check2 = data.object
			})
			if (check1 == "ok" && check2 == "ok") {
				console.log("Server initialized, Installing game server.");
				aws.command('ssm send-command --document-name "AWS-RunShellScript" '+
					'--comment "Copy data to S3 as backup / save" '+
					'--instance-ids '+instanceId+' '+
					'--parameters \'{'+
						'"commands":["'+startCommands[serverName].commands.join('","')+'"],'+
						'"executionTimeout":["86400"],'+
						'"workingDirectory":["/home/ec2-user"]}\' '+
					'--timeout-seconds 600 '+
					'--region us-west-2');
					break;
			} else {
				console.log("Initializing... Please wait.");
				await sleep(10000);
			}
		}
		resolve();
	});
}
// runs a shell script on an instance and returns the output
function getRunCommandOutput (instanceId, command) {
	return new Promise((resolve, reject) => {
		return aws.command('ssm send-command --document-name "AWS-RunShellScript" '+
		'--comment "Copy data to S3 as backup / save" --instance-ids '+ instanceId +' '+
		'--parameters \'{"commands": ["'+command+'"]}\' --region us-west-2 --query "Command.CommandId"')
		.then(async(cmdId) => {
			await sleep(1000) // fails if too fast sometimes so wait 1 second
			return aws.command('ssm get-command-invocation --command-id '+ cmdId.object +' '+
			'--instance-id '+ instanceId +' --query "StandardOutputContent" --output text')
		}).then((pidId) => {
			resolve(pidId.object);
		})
	})
}
// checks if an instance exists, is running, and if a server is running on it.
function checkInstanceStatus (serverName) {
	return new Promise(async(resolve, reject) => {
		if (startInstanceFunctionActive) {
			reject('The "!start" command is active! please wait for it to finish...')
			return
		} else {
			return getInstanceId(serverName)
			.then(async(instanceId) => {
				var computerStatus = await aws.command('ec2 describe-instance-status --instance-ids ' + instanceId + 
				' --filter "Name=instance-state-name,Values=pending,running,shutting-down,terminated" '+
				'"Name=instance-status.status,Values=ok,initializing,not-applicable" '+
				'--query InstanceStatuses[0] --include-all-instances');
				var state = computerStatus.object.InstanceState.Name
				var status = computerStatus.object.InstanceStatus.Status
				if (state === "shutting-down" || state === "terminated") {
					reject('Computer is offline, try !start '+serverName+'.')
					return
				} else if (state === "pending" || status === "initializing") {
					reject('Computer is starting... Please wait.')
					return
				} else {
					var commandList = startCommands[serverName].commands;
					for (i=0; i < commandList.length; i++) {
						var pidId = await getRunCommandOutput(instanceId, 'pgrep -f \\"'+commandList[i]+'\\"');
						if (/^\d+$/.test(pidId) && i === commandList.length -1) {
							return getRunCommandOutput(instanceId, "ps -o etimes= -p "+pidId)
						} else if (/^\d+$/.test(pidId)) {
							reject('Computer is starting... Please wait.')
							return
						}
					}
					reject('Computer is on but the server isnt!? Try !restart.')
					return
				}
			}).then((upTime) => {
				if (upTime > 300) {
					resolve('Great news! both the computer and server are on!');
					return
				} else {
					resolve('Great news! both the computer and server are on\n'+
					'However the server has been online for less than 5 minutes so give it some time if you cant join immediately!');
					return
				}
			}).catch((error) => {
				console.log(error);
				reject(error);
			})
		}
	});
}
// returns an array of strings. strings are the names of folders in a s3 bucket.
function getServers () {
	return new Promise((resolve) => {
		aws.command('s3 ls s3://mc-server-a00912617').then((output) => {
			var output = output.raw;
			output = output.replace(/PRE| |\n/g,'');
			output = output.slice(0,-1);
			output = output.split('/');
			resolve(output)
		})
	})
}
// checks if the server file exists
function checkForServer(serverName) {
	return new Promise((resolve, reject) => {
		getServers()
		.then((servers) => {
			for (i=0; i<servers.length; i++) {
				if (serverName === servers[i] || serverName === startCommands[servers[i]].alias) {
					resolve();
					return
				}
			}
			reject('Server doesnt exist, try !servers')
		})
	});
}
// restarts the server on an instance
function restartServer (serverName) {
	return new Promise((resolve, reject) => {
		checkInstanceStatus(serverName)
		.then((success) => {
			reject(success)
			return
		})
		.catch((error) => {
			if (error === "Computer is on but the server isnt!? Try !restart.") {
				getInstanceId(serverName)
				.then((instanceId) => {
					len = startCommands[serverName].commands.length
					aws.command('ssm send-command --document-name "AWS-RunShellScript" '+
					'--comment "Copy data to S3 as backup / save" '+
					'--instance-ids '+instanceId+' '+
					'--parameters \'{'+
						'"commands":["'+startCommands[serverName].commands[len-1]+'"],'+
						'"executionTimeout":["86400"],'+
						'"workingDirectory":["/home/ec2-user/server"]}\' '+
					'--timeout-seconds 600 '+
					'--region us-west-2');
					resolve("restarting server! Use !status to check if its up. Bye!")
					return
				})
			} else {
				reject(error)
			}
		})
	})
}
console.log('Spotbot Started.');
bot.on('message', function (user, userID, channelID, message, evt) {
    // Our bot needs to know if it will execute a command
    // It will listen for messages that will start with `!`
    if (message.substring(0, 1) == '!') {
        var args = message.substring(1).split(' ');
        var cmd = args[0];
        switch(cmd) {
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
            	if (args[1] === undefined) {
            		bot.sendMessage({
	                    to: channelID,
	                    message: 'Please enter a server (ex "!ip mcm_server") or type "!servers" for a list of servers'
	            	});
            	} else {
	            	checkForServer(args[1])
	            	.then(() => {
	            		return getIp(args[1])
	            	}).then((ip) => {
	            		bot.sendMessage({
		                    to: channelID,
		                    message: ip
		            	});
	            	}).catch((error) => {
	            		bot.sendMessage({
		                    to: channelID,
		                    message: error
		            	});
	            	});
            	}
            break;
            case 'start':
                if (args[1] === undefined) {
            		bot.sendMessage({
	                    to: channelID,
	                    message: 'Please enter a server (ex "!start mcm_server") or type "!servers" for a list of servers'
	            	});
            	} else {
            		checkForServer(args[1])
            		.then(() => {
		        		bot.sendMessage({
		        			to: channelID,
		        			message: 'Acknowledged Captain! Were getting ready...'
		        		});
		        		return startInstance(args[1])
		        	}).then(async(resolved) => {
						bot.sendMessage({
	            			to: channelID,
	            			message: 'Computer powering on!...'
	            		});
	            		await sleep(3000); // wait for aws to add the tag name to get an instance id
	            		return getInstanceId(args[1])
	            	}).then((instanceId) => {
						createShutdownAlarm(args[1], instanceId);
	            		createBackupEvents(args[1], instanceId);
	            		return startServer(args[1], instanceId)
            		}).then((resolved) => {
						bot.sendMessage({
	            			to: channelID,
	            			message: 'Starting the game server now! You should be able to join in a few minutes, have fun!'
        				});
        				bot.sendMessage({
	            			to: channelID,
	            			message: '!ip ' + args[1]
        				});
            		}).catch((error) => {
						bot.sendMessage({
		        			to: channelID,
		        			message: error
		        		});
	        		});
	            }
            break;
            case 'status':
	            if (args[1] === undefined) {
	        		bot.sendMessage({
	                    to: channelID,
	                    message: 'Please enter a server (ex "!status mcm_server") or type "!servers" for a list of servers'
	            	});
	        	} else {
	        		checkForServer(args[1])
	        		.then(() => {
	        			bot.sendMessage({
			                to: channelID,
			                message: 'Searching!'
			        	});
		            	return checkInstanceStatus(args[1])
		            }).then((successMsg) => {
	            		bot.sendMessage({
			                to: channelID,
			                message: successMsg
			        	});
		            }).catch((error) => {
		            	bot.sendMessage({
		                    to: channelID,
		                    message: error
		                });
		            })
		        }
            break;
            case 'restart':
            	if (args[1] === undefined) {
	        		bot.sendMessage({
	                    to: channelID,
	                    message: 'Please enter a server (ex "!status mcm_server") or type "!servers" for a list of servers'
	            	});
	        	} else {
	        		checkForServer(args[1])
	        		.then(() => {
			            bot.sendMessage({
			            	to: channelID,
			            	message: 'Checking server status first!'
			            })
		            	return restartServer(args[1])
		            }).then((success) => { // note: success is actually error
		            	bot.sendMessage({
			            	to: channelID,
			            	message: success
		            	})
		        	}).catch((error) => { // note: error is actually success
		        		bot.sendMessage({
			            	to: channelID,
			            	message: error
		            	})
		        	})
		        }
            break;
            case 'servers':
            	getServers()
            	.then((servers) => {
            		var msg = ''
            		var n = 0
            		for (i=0; i<servers.length; i++) {
            			n += 1
            			msg += servers[i]
            			msg += ' (' + startCommands[servers[i]].alias + ') '
            			msg += '\t|\t'
            			if (n === 5) {
            				n = 0
            				msg += '\n'
            			}
            		}
            		bot.sendMessage({
	        			to: channelID,
	        			message: 'Heres the list of servers!\n|\t' + msg
	        		});
            	})
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
     		default:
     			bot.sendMessage({
                    to: channelID,
                    message: 'Unknown command! try "!help" for a list of commands.'
                });
            // make half a heart and bot replys with other half
         }
     }
});