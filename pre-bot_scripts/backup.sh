###### This script creates a backup of the game servers files on the s3 bucket
declare server_name=$"mcm_server"
declare s3bucket_name=$"mc-server-a00912617"
declare ID=$(aws ec2 describe-instances --filter "Name=tag:Name,Values=${server_name}" --query "Reservations[0].Instances[0].InstanceId" --output text)
echo ${ID}
aws ssm send-command\
 --document-name "AWS-RunShellScript"\
 --comment "Copy data to S3 as backup / save"\
 --instance-ids "${ID}"\
 --parameters '{"commands":["aws s3 cp ./minecraft_server s3://${s3bucket_name}/mcm_server --recursive"],"executionTimeout":["3600"],"workingDirectory":["/home/ec2-user"]}'\
 --timeout-seconds 600\
 --region us-west-2