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
const s3BucketName = process.env.FOLDER;
// const startCommands = require('./startCommands.json')

// aws may update variables as they change, may need to stop that constant connection later.
class Server {
	constructor(serverName, startCommands, ip=null, status=null, instanceId=null) {
		this._name = serverName;
		this._startCommands = startCommands;
		this._alias = startCommands.alias
		this._ip = ip;
		this._status = status;
		this._startInstanceFunctionActive = false;
		this._instanceId = instanceId;
	}

	get name() {
		return this._name;
	}
	get alias() {
		return this._alias;
	}
	get ip() {
		return this._ip;
	}
	get status() {
		return this._status;
	}

	/**
	* Waits in milliseconds before returning.
	* @param {number} ms - the milliseconds to wait
	*/
	sleep (ms) {
		return new Promise(
			resolve => setTimeout(resolve, ms)
		);
	}
	/**
	* Starts a spot instance then gives it the serverName as a tag.
	* @param {string} serverName - The tag name of the server.
	*/ 
	startInstance () {
		// ##### Start Spot Instance #####
		return new Promise(async(resolve, reject) => {
			// figure out queues or someway to only allow one person to run this function at a time
			// is this function already running? reject if true, else continue
			if (this._startInstanceFunctionActive) {
				reject('Server is already being started');
				return
			} else {
				try {
					this._startInstanceFunctionActive = true;
					await this.checkInstanceRunning(this._name)
					// create spot instance and tag it
					await aws.command('ec2 request-spot-instances '+
						'--availability-zone-group us-west-2 '+
						'--instance-count 1 '+
						'--launch-specification '+
							'\'{"ImageId": "ami-0cb72367e98845d43",'+
							'"KeyName": "Minecraft_Server",'+
							'"SecurityGroupIds": [ "'+this._startCommands.securityGroup+'" ],'+
							'"InstanceType": "'+this._startCommands.instanceType+'",'+
							'"IamInstanceProfile": {"Arn": "arn:aws:iam::392656794647:instance-profile/SSM-Agent"}}\'');
					await this.sleep(3500); // Wait for amazon to start instance.
					var data = await aws.command('ec2 describe-instances '+
						'--filter "Name=instance-state-name,Values=pending" '+
						'--query "Reservations[0].Instances[0]"');
					this._instanceId = data.object.InstanceId
					this._status = data.object.State.Name
					aws.command('ec2 create-tags --resource ' + this._instanceId + ' --tags Key=Name,Value=' + this._name);
					await this.sleep(3000); // wait for aws to add the tag name incase.
					this._startInstanceFunctionActive = false;
					resolve();
				} catch(err) {
					console.log(err);
					this._startInstanceFunctionActive = false;
					reject('The computer is already on try !status or !ip');
				}	
			}
		});
	}
	/**
	* Returns the public ipv4 of a server.
	* @param {string} serverName - the tag name of the server.
	* @returns {promise} string ipv4
	*/
	getIp () {
		return new Promise(async(resolve, reject) => {
			var publicIpv4 = await aws.command('ec2 describe-instances '+
				'--filter "Name=tag:Name,Values=' + this._name + '" '+
				'--query "Reservations[0].Instances[0].PublicIpAddress"')
			if (publicIpv4.object === null) {
				reject('We couldnt find an IP! the server probably isnt up, so try !start or !status');
			} else {
				resolve(publicIpv4.object);	
			}
		})
	}
	/**
	* Returns an instance id based on the tag name.
	* @param {string} serverName - The tag name of the server.
	*/ 
	getInstanceId () {
		return new Promise((resolve, reject) => {
			aws.command('ec2 describe-instances '+
			'--filter "Name=tag:Name,Values=' + this._name +
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
	/**
	* Checks if an instance's state is "running".
	* @param {string} serverName - The tag name of the server.
	*/ 
	checkInstanceRunning () {
		return new Promise(async(resolve, reject) => {
			try {
				let serverStatus = await aws.command('ec2 describe-instances --filter "Name=tag:Name,Values=' + this._name + '" --query Reservations[0]')
				// checks if the instance with this._name exists. If it does but is terminated or shutting down it removes the servers 
				//tag name (this._name)
				if (serverStatus.object != null) {
					var state = serverStatus.object.Instances[0].State.Name
					if (state === "shutting-down" || state === "terminated") {
						let instanceId = await this.getInstanceId();
						aws.command('ec2 delete-tags --resources ' + instanceId + ' --tags Key=Name,Value=' + this._name);
						resolve();
						return
					} else {
						reject();
						return
					}
				} else {
					resolve();
				}
			} catch (err) {
				reject();
				console.log(err);
			}

		});
	}
	/**
	* Creates a cloudwatch alarm, that terminates the instance if networkOut is below threshold (aka no players connected).
	* @param {string} serverName - The tag name of the server.
	* @param {string} instanceId - the instanceId of the server.
	*/ 
	createShutdownAlarm () {
		aws.command('cloudwatch put-metric-alarm '+
		'--alarm-name "alarm when '+this._name+' server doesnt have anyone online for a time" '+
		'--alarm-description "Automatically shutoff the server if no one is connected" '+
		'--metric-name "NetworkOut" '+
		'--alarm-actions "arn:aws:automate:us-west-2:ec2:terminate" '+
		'--dimensions "Name=InstanceId,Value='+this._instanceId+'" '+
		'--evaluation-periods "8" '+
		'--datapoints-to-alarm "7" '+
		'--threshold "'+this._startCommands.threshold+'" '+
		'--comparison-operator "LessThanOrEqualToThreshold" '+
		'--period "300" '+
		'--namespace "AWS/EC2" '+
		'--statistic "Average"');
	}
	/**
	* Creates a cloudwatch event, that will save game files from the server to S3.
	* This event will trigger every 30 minutes and when amazon sends a termination notice.
	* @param {string} this._name - The tag name of the server.
	* @param {string} instanceId - the instanceId of the server.
	*/ 
	createBackupEvents () {
		// backup periodically (30min)
		aws.command("events put-rule "+
			"--name '"+this._name+"_periodic_backup' "+
			"--schedule-expression 'rate(30 minutes)' "+
			"--state 'ENABLED' "+
			"--description 'creates a backup periodically'")
		.then(() => {
			aws.command('events put-targets '+
			'--rule "'+this._name+'_periodic_backup" '+
			'--targets '+
			'"Id"="1",'+
			'"Arn"="arn:aws:ssm:us-west-2::document/AWS-RunShellScript",'+
			'"RunCommandParameters"="{RunCommandTargets={Key=InstanceIds,Values=[' + this._instanceId + ']}}",'+
			'"RoleArn"="arn:aws:iam::392656794647:role/Cloudwatch_run_commands",'+
			'"Input"=\'\"{\\\"commands\\\": [\\\"aws s3 cp ./server s3://' + s3BucketName + '/'+this._name+' --recursive\\\"],'+
			'\\\"workingDirectory\\\": [\\\"/home/ec2-user\\\"],'+
			'\\\"executionTimeout\\\": [\\\"3600\\\"]}\"\'');
		});

		// backup on ec2 spot termination
		aws.command('events put-rule --name "'+this._name+'_interrupt_backup" --event-pattern \'{\"source\":[\"aws.ec2\"],\"detail-type\":[\"EC2 Spot Instance Interruption Warning\"]}\' --state "ENABLED" --description "creates a backup when the instance terminates"')
		.then(() => {
			aws.command('events put-targets '+
			'--rule "'+this._name+'_interrupt_backup" '+
			'--targets '+
			'"Id"="1",'+
			'"Arn"="arn:aws:ssm:us-west-2::document/AWS-RunShellScript",'+
			'"RunCommandParameters"="{RunCommandTargets={Key=InstanceIds,Values=[' + this._instanceId + ']}}",'+
			'"RoleArn"="arn:aws:iam::392656794647:role/Cloudwatch_run_commands",'+
			'"Input"=\'\"{\\\"commands\\\": [\\\"aws s3 cp ./server s3://' + s3BucketName + '/'+this._name+' --recursive\\\"],'+
			'\\\"workingDirectory\\\": [\\\"/home/ec2-user\\\"],'+
			'\\\"executionTimeout\\\": [\\\"3600\\\"]}\"\'');
		});
	}
	/**
	* Runs the commands listed in startcommands.json.
	* @param {string} serverName - The tag name of the server.
	* @param {string} instanceId - the instanceId of the server.
	*/ 
	startServer () {
		return new Promise(async(resolve) => {
			try {
				this._ip = await this.getIp();
				while (true) {
					var data1 = await aws.command('ec2 describe-instance-status --instance-ids '+this._instanceId+' --query "InstanceStatuses[0].InstanceStatus.Status"');
					var check1 = data1.object;
					var data2 = await aws.command('ec2 describe-instance-status --instance-ids '+this._instanceId+' --query "InstanceStatuses[0].SystemStatus.Status"');
					var check2 = data2.object;
					if (check1 == "ok" && check2 == "ok") {
						console.log("Server initialized, Installing game server.");
						aws.command('ssm send-command --document-name "AWS-RunShellScript" '+
							'--comment "Copy data to S3 as backup / save" '+
							'--instance-ids '+this._instanceId+' '+
							'--parameters \'{'+
								'"commands":["'+this._startCommands.commands.join('","')+'"],'+
								'"executionTimeout":["86400"],'+
								'"workingDirectory":["/home/ec2-user"]}\' '+
							'--timeout-seconds 600 '+
							'--region us-west-2');
							break;
					} else {
						console.log("Initializing... Please wait.");
						await this.sleep(10000);
					}
				}
				resolve();
			} catch (err) {
				reject();
				console.log(err);
			}
		});
	}
	/**
	* Runs a shell command on an instance and returns the output.
	* @param {string} instanceId - the instanceId of the server.
	* @param {string} command - the command to be run.
	*/ 
	getRunCommandOutput (command) {
		return new Promise((resolve, reject) => {
			return aws.command('ssm send-command --document-name "AWS-RunShellScript" '+
			'--comment "Copy data to S3 as backup / save" --instance-ids '+ this._instanceId +' '+
			'--parameters \'{"commands": ["'+command+'"]}\' --region us-west-2 --query "Command.CommandId"')
			.then(async(cmdId) => {
				await this.sleep(1000) // fails if too fast sometimes so wait 1 second
				return aws.command('ssm get-command-invocation --command-id '+ cmdId.object +' '+
				'--instance-id '+ this._instanceId +' --query "StandardOutputContent" --output text')
			}).then((pidId) => {
				resolve(pidId.raw);
			})
		})
	}
	/**
	* Checks if an instance exists, is running, and if a server is running on it.
	* @param {string} serverName - The tag name of the server.
	*/ 
	checkInstanceStatus () {
		return new Promise(async(resolve, reject) => {
			try {
				if (this._startInstanceFunctionActive) {
					resolve('The "!start" command is active! please wait for it to finish...');
					return
				} else {
					var computerStatus = await aws.command('ec2 describe-instance-status --instance-ids ' + this._instanceId + 
					' --filter "Name=instance-state-name,Values=pending,running,shutting-down,terminated" '+
					'"Name=instance-status.status,Values=ok,initializing,not-applicable" '+
					'--query InstanceStatuses[0] --include-all-instances');
					var state = computerStatus.object.InstanceState.Name
					var status = computerStatus.object.InstanceStatus.Status
					if (state === "shutting-down" || state === "terminated") {
						resolve('Computer is offline, try !start '+this._name+'.');
						return
					} else if (state === "pending" || status === "initializing") {
						resolve('Computer is starting... Please wait.');
						return
					} else {
						var commandList = this._startCommands.commands;
						for (i=0; i < commandList.length; i++) {
							// pgrep is case sensitive.
							// var pidId = await this.getRunCommandOutput(this._instanceId, 'pgrep -f \\"'+commandList[i]+'\\"');
							// work around.
							var pidId = await this.getRunCommandOutput('ps ax | grep -v grep | grep -i \\"'+commandList[i]+'\\"');
							var pidId = pidId.split(' ')
							var pidId = pidId[0];
							if (/^\d+$/.test(pidId) && i === commandList.length -1) {
								var upTime = await this.getRunCommandOutput("ps -o etimes= -p "+pidId);
								if (upTime > 300) {
									resolve('Great news! both the computer and server are on!');
									return
								} else {
									resolve('Great news! both the computer and server are on\n'+
									'However the server has been online for less than 5 minutes so give it some time if you cant join immediately!');
									return
								}
							} else if (/^\d+$/.test(pidId)) {
								resolve('Computer is starting... Please wait.');
								return
							}
						}
						resolve('Computer is on but the server isnt!? Try !restart.');
						return
					}	
				}	
			} catch(err) {
				console.log(err);
				reject('Unknown error try again later.');
			}
		});
	}
	/**
	* Runs the last command in startCommands.json on the instance.
	* @param {string} serverName - The tag name of the server.
	*/ 
	restartServer () {
		return new Promise(async(resolve, reject) => {
			try {
				status = await checkInstanceStatus();
				if (status === "Computer is on but the server isnt!? Try !restart.") {
					let len = this._startCommands.commands.length
					aws.command('ssm send-command --document-name "AWS-RunShellScript" '+
					'--comment "Copy data to S3 as backup / save" '+
					'--instance-ids '+this._instanceId+' '+
					'--parameters \'{'+
						'"commands":["'+this._startCommands.commands[len-1]+'"],'+
						'"executionTimeout":["86400"],'+
						'"workingDirectory":["/home/ec2-user/server"]}\' '+
					'--timeout-seconds 600 '+
					'--region us-west-2');
					resolve("restarting server! Use !status to check if its up. Bye!")
				} else {
					reject(status);
				}
				
			} catch(err) {
				console.log(err);
				reject('Unknown error try again later.');
			}
		});
	}
}
module.exports = Server